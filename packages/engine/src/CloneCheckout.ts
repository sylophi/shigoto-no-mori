// Clone checkout: a new worktree's tracked files cloned out of an
// existing checkout (APFS clonefile) instead of written by git. A clone
// shares the source's blocks, so a whole directory lands in one call
// however many files it holds, and the new worktree's index is written
// here with each clone's own stat, so git trusts the files without
// reading them back. Letting git build that index would hash every
// clone, slower than the plain checkout this replaces.
//
// A file is only cloned when the source's index vouches for its bytes:
// the same blob and mode as the new worktree's commit, an ordinary entry
// (no conflict, skip-worktree, assume-unchanged, intent-to-add), not
// racily clean, no attribute or config on either side that would make a
// checkout write anything but the blob, and, checked once it is cloned,
// a file on disk whose stat still matches what git recorded when it last
// hashed it (to the nanosecond, so an edit before or during the clone
// shows), with nothing on it a checkout wouldn't give it (other
// permissions, file flags, extended attributes). Everything else is left
// to `git checkout-index`, which writes it as a checkout would.
//
// Any failure resets the worktree to a plain checkout, so the worst a
// clone checkout does is cost the time it took.
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";
import { orderSources } from "./CarryOver.ts";
import * as Darwin from "./Darwin.ts";
import * as Git from "./Git.ts";
import { splitZ } from "./gitParse.ts";
import {
  ancestors,
  blobBytes,
  type CheckoutConfig,
  checkedOutPerm,
  checkoutConverts,
  CONVERSION_ATTRS,
  type IndexStat,
  indexBody,
  indexStatOf,
  isAscii,
  matchesMode,
  olderThan,
  ordinaryIndexFlags,
  parseLsFilesDebug,
  parseLsTree,
  sameFile,
  type SourceEntry,
  toHex,
  type TreeEntry,
  verifiedRecord,
} from "./gitIndex.ts";
import * as Paths from "./Paths.ts";
import { worktreeIdFromPath } from "./worktreeLayout.ts";

// A checkout a new worktree's files may be cloned from.
export type CloneSource = {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
  readonly isPrimary: boolean;
  readonly detached: boolean;
};

// How a clone checkout went: tracked files cloned, paths git wrote
// (submodules included), and clones read back and hashed.
export type CloneReport = {
  readonly cloned: number;
  readonly written: number;
  readonly hashed: number;
};

// Why a clone checkout gave up, the worktree then checked out by git.
export class CloneFailed extends Schema.TaggedError<CloneFailed>()(
  "CloneFailed",
  {
    reason: Schema.Literals([
      "index-changed",
      "attributes-changed",
      "unknown-format",
      "read",
      "clone",
      "write",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "index-changed":
        return "source index changed while it was read";
      case "attributes-changed":
        return "attributes changed while cloning";
      case "unknown-format":
        return "unknown object format";
      case "read":
        return "couldn't read the source";
      case "clone":
        return "couldn't clone the files";
      case "write":
        return "couldn't write the index";
    }
  }
}

// A worktree added --no-checkout that neither the clone nor git's own
// checkout filled. The caller undoes the add, as git does when its own
// checkout fails.
export class CheckoutUnfinished extends Schema.TaggedError<CheckoutUnfinished>()(
  "CheckoutUnfinished",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't check out ${this.path}.`;
  }
}

// A post-checkout hook that failed, as `git worktree add` reports one:
// the worktree stays. What the hook printed is the cause.
export class HookFailed extends Schema.TaggedError<HookFailed>()("HookFailed", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The post-checkout hook failed.";
  }
}

export class CloneCheckout extends Context.Service<
  CloneCheckout,
  {
    // The checkout a new worktree at `destination` would clone from: the
    // one on `baseBranch`, else the primary, else any other. None when
    // the project or every checkout rules a clone out.
    readonly pickSource: (input: {
      readonly repo: string;
      readonly checkouts: ReadonlyArray<CloneSource>;
      readonly destination: string;
      readonly baseBranch: string;
    }) => Effect.Effect<Option.Option<CloneSource>>;
    // Fills a worktree made --no-checkout: its files cloned from `source`
    // where that is safe and written by git elsewhere, else all written by
    // git when the clone gives up, then the post-checkout hook git
    // skipped. Answers how the clone went, or why it gave up.
    readonly finish: (input: {
      readonly source: string;
      readonly worktree: string;
    }) => Effect.Effect<
      Result.Result<CloneReport, CloneFailed>,
      CheckoutUnfinished | HookFailed | Git.GitError
    >;
    // The clone checkout itself, for a worktree made --no-checkout. On
    // failure the caller resets the worktree.
    readonly clone: (
      source: string,
      worktree: string,
    ) => Effect.Effect<CloneReport, CloneFailed>;
    // Empties the worktree (but its .git link) and checks HEAD out with
    // git, the state a plain `git worktree add` leaves.
    readonly resetToPlainCheckout: (
      worktree: string,
    ) => Effect.Effect<void, Git.GitError>;
    // Drops what clones proved about a source's files.
    readonly forget: (worktreeId: string) => Effect.Effect<void>;
  }
>()("sm/engine/CloneCheckout") {}

// --- helpers ------------------------------------------------------------

// The flags a clone may keep: what a checkout's own files can carry
// (compression, document tracking).
const UF_COMPRESSED = 0x20;
const UF_TRACKED = 0x40;
const KEPT_FLAGS = UF_COMPRESSED | UF_TRACKED;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

const nanos = (sec: number, nsec: number) =>
  BigInt(sec) * 1_000_000_000n + BigInt(nsec);

const maxOf = (...values: bigint[]) =>
  values.reduce((a, b) => (a > b ? a : b), 0n);

// A clone the source no longer has, or isn't ours to read: git writes it
// instead.
const LEFT_TO_GIT = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

// An environment variable, empty when unset.
const env = (name: string) =>
  Config.String(name).pipe(Effect.orElseSucceed(() => ""));

// What decided the conversions, read once and read again.
type Conversions = {
  readonly attr: string;
  readonly sourceAttr: string;
  readonly config: CheckoutConfig;
  readonly sourceConfig: CheckoutConfig;
};

const sameConversions = (a: Conversions, b: Conversions) =>
  a.attr === b.attr &&
  a.sourceAttr === b.sourceAttr &&
  JSON.stringify(a.config) === JSON.stringify(b.config) &&
  JSON.stringify(a.sourceConfig) === JSON.stringify(b.sourceConfig);

const RECORDS_PER_STATEMENT = 1000;

const chunksOf = <A>(items: ReadonlyArray<A>): A[][] => {
  const chunks: A[][] = [];
  for (let i = 0; i < items.length; i += RECORDS_PER_STATEMENT) {
    chunks.push(items.slice(i, i + RECORDS_PER_STATEMENT));
  }
  return chunks;
};

const make = Effect.gen(function* () {
  const git = yield* Git.Git;
  const darwin = yield* Darwin.Darwin;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const paths = yield* Paths.Paths;

  const configHome = Effect.gen(function* () {
    const xdg = yield* env("XDG_CONFIG_HOME");
    return xdg !== "" ? xdg : path.join(paths.home, ".config");
  });

  // The process's umask, read the only way that doesn't set it: a file
  // made with every permission keeps those the umask leaves.
  const umask = yield* Effect.cached(
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fs.makeTempDirectoryScoped();
        const probe = path.join(dir, "probe");
        yield* fs.writeFile(probe, new Uint8Array(), {
          mode: 0o777,
          flag: "wx",
        });
        return 0o777 & ~(yield* fs.stat(probe)).mode;
      }),
    ).pipe(Effect.orElseSucceed(() => 0o022)),
  );

  // lstat of many absolute paths in one helper call, by path.
  // lstat of paths relative to a root, by relative path.
  const lstatUnder = (root: string, relative: ReadonlyArray<string>) =>
    relative.length === 0
      ? Effect.succeed(new Map<string, Darwin.LstatEntry>())
      : darwin.lstat({ root, paths: relative }).pipe(
          Stream.runCollect,
          Effect.map(
            (entries) =>
              new Map(
                entries.flatMap((entry) =>
                  Darwin.isFailed(entry) ? [] : [[entry.path, entry]],
                ),
              ),
          ),
        );

  // lstat of absolute paths, by path. Best effort: a path it can't answer
  // for reads as absent.
  const lstatAll = (files: ReadonlyArray<string>) =>
    lstatUnder(
      "/",
      files.map((file) => file.slice(1)),
    ).pipe(
      Effect.map(
        (found) =>
          new Map([...found].map(([rel, entry]) => [`/${rel}`, entry])),
      ),
      Effect.orElseSucceed(() => new Map<string, Darwin.LstatEntry>()),
    );

  const gitPath = (checkout: string, name: string) =>
    git
      .run(checkout, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        name,
      ])
      .pipe(Effect.map((out) => out.trim()));

  const configValue = (checkout: string, args: ReadonlyArray<string>) =>
    git.run(checkout, ["config", ...args]).pipe(
      Effect.map((out) => Option.some(out.trim().toLowerCase())),
      // Unset reads as an exit code 1 with no output.
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  // A boolean setting git reads as true.
  const configBool = (checkout: string, key: string) =>
    configValue(checkout, ["--bool", key]).pipe(
      Effect.map((value) => Option.contains(value, "true")),
    );

  const readCheckoutConfig = (checkout: string) =>
    Effect.gen(function* () {
      const eol = Option.getOrElse(
        yield* configValue(checkout, ["--get", "core.eol"]),
        () => "",
      );
      // git reads booleans its own way, so it's asked to. autocrlf also
      // takes "input", which isn't one. A value git can't read at all is
      // taken as true, which only leaves more to git.
      let autocrlf = "false";
      const raw = yield* configValue(checkout, ["--get", "core.autocrlf"]);
      if (Option.isSome(raw) && raw.value === "input") autocrlf = "input";
      else if (Option.isSome(raw)) {
        const value = yield* configValue(checkout, [
          "--type=bool",
          "--get",
          "core.autocrlf",
        ]);
        if (Option.isNone(value) || value.value === "true") autocrlf = "true";
      }
      let symlinks = true;
      if (
        Option.isSome(yield* configValue(checkout, ["--get", "core.symlinks"]))
      ) {
        const value = yield* configValue(checkout, [
          "--type=bool",
          "--get",
          "core.symlinks",
        ]);
        symlinks = Option.isSome(value) && value.value === "true";
      }
      return { autocrlf, eol, symlinks } satisfies CheckoutConfig;
    });

  // What decides each path's conversions: the attributes as a checkout
  // of HEAD sees them and as the source saw them when it wrote and last
  // hashed its files, and both sides' config.
  const readConversions = (
    source: string,
    worktree: string,
    targetPaths: string,
  ) =>
    Effect.all(
      {
        attr: git.run(
          worktree,
          [
            "check-attr",
            "--source",
            "HEAD",
            "-z",
            "--stdin",
            ...CONVERSION_ATTRS,
          ],
          { stdin: targetPaths },
        ),
        sourceAttr: git.run(
          source,
          ["check-attr", "-z", "--stdin", ...CONVERSION_ATTRS],
          { stdin: targetPaths },
        ),
        config: readCheckoutConfig(worktree),
        sourceConfig: readCheckoutConfig(source),
      },
      { concurrency: "unbounded" },
    );

  // RemoveAll for what a clone can leave: a flag pinning a file, a
  // folder that can't be listed or emptied.
  const forceRemove = (target: string) =>
    fs.remove(target, { recursive: true, force: true }).pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          yield* darwin
            .flags({ root: target, clear: true })
            .pipe(Stream.runDrain, Effect.ignore);
          const entries = yield* darwin.lstat({ root: target }).pipe(
            Stream.runCollect,
            Effect.orElseSucceed(() => []),
          );
          for (const entry of entries) {
            if (!Darwin.isFailed(entry) && (entry.mode & S_IFMT) === S_IFDIR) {
              yield* fs
                .chmod(path.join(target, entry.path), 0o700)
                .pipe(Effect.ignore);
            }
          }
          yield* fs.remove(target, { recursive: true, force: true });
        }),
      ),
    );

  const recordsOf = (source: string) =>
    sql<{ path: string; record: string }>`
      SELECT path, record FROM clone_verified
      WHERE source_id = ${worktreeIdFromPath(source)}`.pipe(
      Effect.map(
        (rows) => new Map(rows.map(({ path: p, record }) => [p, record])),
      ),
      Effect.orElseSucceed(() => new Map<string, string>()),
    );

  // Adds the newly proven records, dropping any whose path no longer has
  // that blob and stat in the source's index (`current`). Best effort:
  // without them the next clone reads those files again.
  const keepRecords = (
    source: string,
    added: ReadonlyMap<string, string>,
    current: (file: string, record: string) => boolean,
  ) => {
    const sourceId = worktreeIdFromPath(source);
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const stale = [...(yield* recordsOf(source))]
            .filter(([file, record]) => !current(file, record))
            .map(([file]) => file);
          // In chunks, under SQLite's limit on a statement's parameters.
          for (const chunk of chunksOf(stale)) {
            yield* sql`DELETE FROM clone_verified WHERE source_id = ${sourceId}
              AND ${sql.in("path", chunk)}`;
          }
          for (const chunk of chunksOf([...added])) {
            yield* sql`INSERT INTO clone_verified ${sql.insert(
              chunk.map(([file, record]) => ({
                source_id: sourceId,
                path: file,
                record,
              })),
            )} ON CONFLICT (source_id, path) DO UPDATE SET record = excluded.record`;
          }
        }),
      )
      .pipe(Effect.ignore);
  };

  // The object id git gives the file at `file` as a blob of this mode,
  // its bytes taken as they are: a symlink's target, a file's content.
  const blobId = (file: string, mode: number, algorithm: "SHA-1" | "SHA-256") =>
    Effect.gen(function* () {
      const content =
        mode === 0o120000
          ? new TextEncoder().encode(yield* fs.readLink(file))
          : yield* fs.readFile(file);
      return toHex(yield* crypto.digest(algorithm, blobBytes(content)));
    });

  const clone = Effect.fn("CloneCheckout.clone")(function* (
    source: string,
    worktree: string,
  ) {
    const fail = (reason: CloneFailed["reason"]) => (cause: unknown) =>
      new CloneFailed({ reason, cause });
    // Before anything is read: an attributes file changed after this
    // changed what the reads went by.
    const started = yield* Clock.currentTimeNanos;
    const mask = yield* umask;

    const targets = parseLsTree(
      yield* git
        .run(worktree, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"])
        .pipe(Effect.mapError(fail("read"))),
    );
    const targetPaths = targets.map((target) => `${target.path}\0`).join("");
    const targetOids = targets
      .filter((target) => target.mode !== 0o160000)
      .map((target) => `${target.oid}\n`)
      .join("");

    // The source's index read between two looks at its mtime. A rewrite
    // in between (a concurrent git) leaves the raciness cutoff unknown,
    // so nothing is cloned on its word.
    const readIndex = Effect.gen(function* () {
      const index = yield* gitPath(source, "index");
      const mtime = lstatAll([index]).pipe(
        Effect.map((found) => found.get(index)),
      );
      const before = yield* mtime;
      const listed = yield* git.run(source, [
        "ls-files",
        "-s",
        "-z",
        "--debug",
      ]);
      const after = yield* mtime;
      if (
        before === undefined ||
        after === undefined ||
        before.mtimeSec !== after.mtimeSec ||
        before.mtimeNsec !== after.mtimeNsec
      ) {
        return yield* new CloneFailed({ reason: "index-changed" });
      }
      const { mtimeSec: sec, mtimeNsec: nsec } = indexStatOf(before);
      return { listed, sec, nsec };
    });

    // Where the attributes outside the tree live, as git looks for them,
    // and the config files that decide which one is the global one.
    const readAttributeFiles = Effect.gen(function* () {
      const home = yield* configHome;
      let globalAttrs = (yield* git
        .run(source, ["config", "--path", "--get", "core.attributesFile"])
        .pipe(Effect.orElseSucceed(() => ""))).trim();
      if (globalAttrs === "")
        globalAttrs = path.join(home, "git", "attributes");
      else if (!path.isAbsolute(globalAttrs)) {
        globalAttrs = path.join(source, globalAttrs);
      }
      const infoAttrs = yield* gitPath(source, "info/attributes");
      const origins = yield* git
        .run(source, ["config", "--list", "--show-origin", "--name-only", "-z"])
        .pipe(Effect.orElseSucceed(() => ""));
      const fields = origins.split("\0");
      const configFiles: string[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const field = fields[i] ?? "";
        if (!field.startsWith("file:")) continue;
        const file = field.slice("file:".length);
        configFiles.push(
          path.isAbsolute(file) ? file : path.join(source, file),
        );
      }
      configFiles.push(
        path.join(paths.home, ".gitconfig"),
        path.join(home, "git", "config"),
      );
      return { globalAttrs, infoAttrs, configFiles };
    });

    const reads = yield* Effect.all(
      {
        index: readIndex,
        others: git.run(source, ["ls-files", "-z", "--others", "--directory"]),
        conversions: readConversions(source, worktree, targetPaths),
        sizes: git.run(
          worktree,
          ["cat-file", "--buffer", "--batch-check=%(objectname) %(objectsize)"],
          { stdin: targetOids },
        ),
        format: git.run(worktree, ["rev-parse", "--show-object-format"]),
        attributeFiles: readAttributeFiles,
      },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) => Effect.fail(fail("read")(error)),
        GitOutputTooLargeError: (error) => Effect.fail(fail("read")(error)),
      }),
    );

    const format = reads.format.trim();
    const algorithm =
      format === "sha1" ? "SHA-1" : format === "sha256" ? "SHA-256" : undefined;
    if (algorithm === undefined) {
      return yield* new CloneFailed({
        reason: "unknown-format",
        cause: format,
      });
    }
    const sourceEntries = yield* Effect.try({
      try: () => parseLsFilesDebug(reads.index.listed),
      catch: fail("read"),
    });
    const converted = checkoutConverts(
      reads.conversions.attr,
      reads.conversions.config,
    );
    for (const p of checkoutConverts(
      reads.conversions.sourceAttr,
      reads.conversions.sourceConfig,
    )) {
      converted.add(p);
    }
    const blobSize = new Map<string, number>();
    for (const line of reads.sizes.split("\n")) {
      const [oid, size] = line.split(" ");
      if (oid !== undefined && size !== undefined && /^\d+$/.test(size)) {
        blobSize.set(oid, Number(BigInt.asUintN(32, BigInt(size))));
      }
    }

    // A conflicted path's stage entries all carry stage bits, which
    // ordinaryIndexFlags turns down.
    const bySourcePath = new Map<string, SourceEntry>(
      sourceEntries.map((entry) => [entry.path, entry]),
    );
    // Names a case-insensitive disk takes for one are left to git, which
    // writes them in index order as a checkout does. APFS also folds
    // Unicode normalization, so names outside ASCII go to git too.
    const spelling = new Map<string, string>();
    const colliding = new Set<string>();
    const claim = (name: string, as: string) => {
      const key = name.toLowerCase();
      const previous = spelling.get(key);
      if (previous === undefined) spelling.set(key, as);
      else if (previous !== as) colliding.add(key);
      return previous !== undefined && previous === as;
    };
    for (const target of targets) {
      claim(target.path, target.path);
      for (const dir of ancestors(target.path)) {
        if (claim(dir, `${dir}/`)) break;
      }
    }
    const collides = (p: string) => {
      if (colliding.size === 0) return false;
      if (colliding.has(p.toLowerCase())) return true;
      for (const dir of ancestors(p)) {
        if (colliding.has(dir.toLowerCase())) return true;
      }
      return false;
    };

    // What the source's index says can be cloned. The files themselves
    // are checked against it once cloned.
    const { sec: indexSec, nsec: indexNsec } = reads.index;
    const clonable = new Set<string>();
    for (const target of targets) {
      const entry = bySourcePath.get(target.path);
      // The blob's size too: the conversions left (CRLF to LF on the way
      // in) only ever shrink a file, so a file its blob's size holds the
      // blob's bytes.
      const size = blobSize.get(target.oid);
      if (
        entry === undefined ||
        !ordinaryIndexFlags(entry.flags) ||
        target.mode === 0o160000 ||
        (target.mode === 0o120000 && !reads.conversions.config.symlinks) ||
        entry.mode !== target.mode ||
        entry.oid !== target.oid ||
        converted.has(target.path) ||
        !isAscii(target.path) ||
        collides(target.path) ||
        size === undefined ||
        entry.stat.size !== size ||
        !olderThan(
          entry.stat.mtimeSec,
          entry.stat.mtimeNsec,
          indexSec,
          indexNsec,
        )
      ) {
        continue;
      }
      clonable.add(target.path);
    }

    // A directory is cloned whole when everything in it on the source
    // side is a file being cloned. Each other path marks its folders as
    // needing a walk.
    const impure = new Set<string>();
    const markParents = (p: string) => {
      for (const dir of ancestors(p)) {
        if (impure.has(dir)) return;
        impure.add(dir);
      }
    };
    for (const other of reads.others.split("\0")) {
      if (other !== "") markParents(other);
    }
    for (const entry of sourceEntries) {
      if (!clonable.has(entry.path)) markParents(entry.path);
    }
    const targetDirs = new Set<string>();
    const tracked = new Set<string>();
    for (const target of targets) {
      tracked.add(target.path);
      if (!clonable.has(target.path)) markParents(target.path);
      for (const dir of ancestors(target.path)) {
        if (targetDirs.has(dir)) break;
        targetDirs.add(dir);
      }
    }

    // Each cloned path's unit: its outermost folder that can go whole,
    // else the file itself.
    const units = new Set<string>();
    const parents = new Set<string>();
    for (const p of clonable) {
      let unit = p;
      for (let i = 0; i < p.length; i++) {
        if (p[i] === "/" && !impure.has(p.slice(0, i))) {
          unit = p.slice(0, i);
          break;
        }
      }
      if (!units.has(unit)) {
        units.add(unit);
        const parent = path.dirname(unit);
        if (parent !== ".") parents.add(parent);
      }
    }
    yield* Effect.forEach(
      parents,
      (parent) =>
        fs.makeDirectory(path.join(worktree, parent), { recursive: true }),
      { concurrency: 8, discard: true },
    ).pipe(Effect.mapError(fail("clone")));
    const unitList = [...units].toSorted();
    const cloned = yield* darwin
      .clone({ from: source, to: worktree, paths: unitList })
      .pipe(Stream.runCollect, Effect.mapError(fail("clone")));
    // Gone from the source since its index was written, or not ours to
    // read: git writes it instead (the check below turns down whatever
    // did or didn't land).
    const refused = cloned.find(
      (entry) => Darwin.isFailed(entry) && !LEFT_TO_GIT.has(entry.error.code),
    );
    if (refused !== undefined) {
      return yield* new CloneFailed({ reason: "clone", cause: refused });
    }

    // A whole-directory clone also took whatever appeared in it since the
    // source was listed, and names as the source's disk spells them.
    // Anything that isn't a tracked path, spelled as git has it, goes, and
    // each folder gets what a checkout creates it with.
    yield* pruneUntracked(
      worktree,
      unitList.filter((unit) => targetDirs.has(unit)),
      tracked,
      targetDirs,
      0o777 & ~mask,
    ).pipe(Effect.mapError(fail("clone")));

    // When the attributes that apply to a path last changed, as far as
    // ctimes can tell: each attributes file's and its folder's (a deleted
    // .gitattributes shows there), for a path every folder above it. A
    // source file git last checked after all of them was checked under
    // the attributes in force now. One checked before may hold bytes a
    // dropped conversion made, so its clone is read back and hashed once:
    // the record below keeps the proof while the file stays as it is.
    const folders = new Set<string>();
    for (const p of clonable) {
      for (const dir of ancestors(p)) {
        if (folders.has(dir)) break;
        folders.add(dir);
      }
    }
    const sortedFolders = [...folders].toSorted();
    const { globalAttrs, infoAttrs, configFiles } = reads.attributeFiles;
    const attributesOf = (dir: string) =>
      path.join(source, dir, ".gitattributes");
    const looked = [
      globalAttrs,
      infoAttrs,
      attributesOf("."),
      ...sortedFolders.map(attributesOf),
    ];
    const stats = yield* lstatAll([
      ...new Set([
        ...looked,
        ...looked.map((file) => path.dirname(file)),
        ...configFiles,
        ...configFiles.map((file) => path.dirname(file)),
        ...sortedFolders.map((dir) => path.join(source, dir)),
      ]),
    ]);
    let newest = 0n;
    const ctimeOf = (file: string) => {
      const st = stats.get(file);
      if (st === undefined) return 0n;
      const at = nanos(st.ctimeSec, st.ctimeNsec);
      if (at > newest) newest = at;
      return at;
    };
    const fileAndFolder = (file: string) =>
      file === "" ? 0n : maxOf(ctimeOf(file), ctimeOf(path.dirname(file)));
    // A config file's own ctime, or its folder's when it's gone. Left out
    // of `newest`: the folders include the home folder, which changes all
    // the time, and a file stale for no reason only costs a read back.
    let configChanged = 0n;
    for (const file of configFiles) {
      const st = stats.get(file) ?? stats.get(path.dirname(file));
      if (st !== undefined) {
        configChanged = maxOf(configChanged, nanos(st.ctimeSec, st.ctimeNsec));
      }
    }
    const attrsChanged = new Map<string, bigint>([
      [
        ".",
        maxOf(
          configChanged,
          fileAndFolder(globalAttrs),
          fileAndFolder(infoAttrs),
          fileAndFolder(attributesOf(".")),
        ),
      ],
    ]);
    // git doesn't look past a symlinked folder for a tracked path, and
    // neither does this: a source path is only taken when each folder
    // above it is a real one.
    const realDir = new Map<string, boolean>([[".", true]]);
    for (const dir of sortedFolders) {
      const st = stats.get(path.join(source, dir));
      realDir.set(
        dir,
        st !== undefined &&
          (st.mode & S_IFMT) === S_IFDIR &&
          realDir.get(path.dirname(dir)) === true,
      );
      attrsChanged.set(
        dir,
        maxOf(
          attrsChanged.get(path.dirname(dir)) ?? 0n,
          fileAndFolder(attributesOf(dir)),
        ),
      );
    }
    // Attributes that changed while this ran may make a checkout write
    // what the conversion checks didn't expect. They're read again: git
    // checks out with the ones in force now if they differ.
    if (newest >= started) {
      const again = yield* readConversions(source, worktree, targetPaths).pipe(
        Effect.option,
      );
      if (
        Option.isNone(again) ||
        !sameConversions(again.value, reads.conversions)
      ) {
        return yield* new CloneFailed({ reason: "attributes-changed" });
      }
    }

    // Files git last checked before the attributes changed, proven by
    // hashing unless an earlier clone proved that very version. Strictly
    // before: a change at the very instant the file last changed is that
    // change.
    const stale = (p: string) => {
      const st = bySourcePath.get(p)?.stat;
      return (
        st !== undefined &&
        nanos(st.ctimeSec, st.ctimeNsec) <
          (attrsChanged.get(path.dirname(p)) ?? 0n)
      );
    };
    const clonableList = [...clonable];
    const verified = clonableList.some(stale)
      ? yield* recordsOf(source)
      : new Map<string, string>();

    // Each clone is kept only if the source file still has the stat its
    // index entry recorded when git last hashed it (a write moves ctime
    // forward for good), and carries nothing a checkout wouldn't give it:
    // the permissions git creates files with, no file flags or extended
    // attributes. Anything else goes to git.
    const [sourceStats, cloneStats, sourceXattrs] = yield* Effect.all(
      [
        lstatUnder(source, clonableList),
        lstatUnder(worktree, clonableList),
        darwin.xattrs({ root: source, paths: clonableList }).pipe(
          Stream.runCollect,
          Effect.map(
            (entries) =>
              new Map(
                entries.flatMap((entry) =>
                  Darwin.isFailed(entry) ? [] : [[entry.path, entry.names]],
                ),
              ),
          ),
        ),
      ],
      { concurrency: 3 },
    ).pipe(Effect.mapError(fail("clone")));
    const kept = new Map<string, IndexStat>();
    const rejected: string[] = [];
    // The stale clones to read back, each with the record that proves it.
    const toHash: Array<{
      readonly p: string;
      readonly entry: SourceEntry;
      readonly stat: IndexStat;
      readonly record: string;
    }> = [];
    for (const p of clonableList) {
      const raw = sourceStats.get(p);
      const entry = bySourcePath.get(p);
      const names = sourceXattrs.get(p);
      const st = cloneStats.get(p);
      if (
        entry === undefined ||
        raw === undefined ||
        st === undefined ||
        names === undefined
      ) {
        rejected.push(p);
        continue;
      }
      const after = indexStatOf(raw);
      const cloneStat = indexStatOf(st);
      if (
        realDir.get(path.dirname(p)) !== true ||
        !sameFile(after, entry.stat) ||
        !matchesMode(after, entry.mode) ||
        !checkedOutPerm(after, entry.mode, mask) ||
        (raw.flags & ~KEPT_FLAGS) !== 0 ||
        names.some((name) => name !== "com.apple.provenance") ||
        // clonefile keeps the mtime and mode: anything else isn't our
        // clone.
        cloneStat.mtimeSec !== after.mtimeSec ||
        cloneStat.mtimeNsec !== after.mtimeNsec ||
        cloneStat.size !== after.size ||
        cloneStat.mode !== after.mode
      ) {
        rejected.push(p);
        continue;
      }
      const record = verifiedRecord(entry.oid, entry.stat);
      if (stale(p) && verified.get(p) !== record) {
        toHash.push({ p, entry, stat: cloneStat, record });
      } else {
        kept.set(p, cloneStat);
      }
    }
    const proven = new Map<string, string>();
    const hashes = yield* Effect.forEach(
      toHash,
      ({ p, entry }) =>
        blobId(path.join(worktree, p), entry.mode, algorithm).pipe(
          Effect.option,
        ),
      { concurrency: 4 },
    );
    toHash.forEach(({ p, entry, stat, record }, index) => {
      const oid = hashes[index];
      if (oid !== undefined && Option.contains(oid, entry.oid)) {
        kept.set(p, stat);
        proven.set(p, record);
      } else {
        rejected.push(p);
      }
    });
    const hashed = toHash.length;
    // A clone turned down is removed for git to write afresh: it may carry
    // what git can't overwrite.
    yield* Effect.forEach(
      rejected,
      (p) => forceRemove(path.join(worktree, p)),
      { concurrency: 8, discard: true },
    ).pipe(Effect.mapError(fail("clone")));

    if (proven.size > 0) {
      yield* keepRecords(source, proven, (file, record) => {
        const entry = bySourcePath.get(file);
        return (
          entry !== undefined &&
          verifiedRecord(entry.oid, entry.stat) === record
        );
      });
    }

    // Git writes the rest, submodules' empty folders included, in index
    // order as a checkout would.
    const toGit = targets
      .filter((target) => !kept.has(target.path))
      .map((target) => target.path);
    yield* writeIndex(worktree, targets, kept, algorithm).pipe(
      Effect.mapError(fail("write")),
    );
    if (toGit.length > 0) {
      // -f: a path cloned and then turned down is overwritten. -u records
      // the written files' stat in the index.
      yield* git
        .run(worktree, ["checkout-index", "-f", "-u", "-z", "--stdin"], {
          stdin: toGit.join("\0"),
        })
        .pipe(Effect.mapError(fail("write")));
    }
    return { cloned: kept.size, written: toGit.length, hashed };
  });

  // Walks the whole-directory clones and removes whatever isn't a tracked
  // file or a folder leading to one, giving each folder what a checkout
  // creates it with: the mode, no file flags, no extended attributes but
  // provenance.
  const pruneUntracked = (
    worktree: string,
    dirs: ReadonlyArray<string>,
    tracked: ReadonlySet<string>,
    targetDirs: ReadonlySet<string>,
    dirMode: number,
  ) =>
    Effect.gen(function* () {
      // What each unit's walk finds: folders to keep and the mode they
      // need, and entries to remove. A child of a removed entry goes with
      // it.
      const plans = yield* Effect.forEach(
        dirs,
        (unit) =>
          darwin.lstat({ root: path.join(worktree, unit) }).pipe(
            Stream.runCollect,
            Effect.map((entries) => {
              const keep: Array<{ rel: string; chmod: boolean }> = [];
              const gone: string[] = [];
              const goneSet = new Set<string>();
              for (const entry of entries.toSorted((a, b) =>
                a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
              )) {
                // A folder the walk couldn't read may hold what must go.
                if (Darwin.isFailed(entry)) {
                  return Effect.fail(entry.error);
                }
                const rel = entry.path === "." ? unit : `${unit}/${entry.path}`;
                if ([...ancestors(rel)].some((dir) => goneSet.has(dir))) {
                  continue;
                }
                const isDir = (entry.mode & S_IFMT) === S_IFDIR;
                if (isDir ? targetDirs.has(rel) : tracked.has(rel)) {
                  if (isDir) {
                    keep.push({
                      rel,
                      chmod: (entry.mode & 0o7777) !== dirMode,
                    });
                  }
                } else {
                  gone.push(rel);
                  goneSet.add(rel);
                }
              }
              return Effect.succeed({ keep, gone });
            }),
            Effect.flatten,
          ),
        { concurrency: 4 },
      );
      const keep = plans.flatMap((plan) => plan.keep);
      yield* Effect.forEach(
        plans.flatMap((plan) => plan.gone),
        (rel) => forceRemove(path.join(worktree, rel)),
        { concurrency: 8, discard: true },
      );
      yield* Effect.forEach(
        keep.filter((dir) => dir.chmod),
        ({ rel }) => fs.chmod(path.join(worktree, rel), dirMode),
        { concurrency: 8, discard: true },
      );
      if (keep.length > 0) {
        const folders = keep.map(({ rel }) => rel);
        yield* darwin
          .flags({ root: worktree, paths: folders, clear: true })
          .pipe(Stream.runDrain);
        yield* darwin
          .xattrs({ root: worktree, paths: folders, strip: true })
          .pipe(Stream.runDrain);
      }
    });

  // The worktree's index, written through git's own lock file so a
  // concurrent git in the worktree fails cleanly instead of losing a
  // write.
  const writeIndex = (
    worktree: string,
    targets: ReadonlyArray<TreeEntry>,
    stats: ReadonlyMap<string, IndexStat>,
    algorithm: "SHA-1" | "SHA-256",
  ) =>
    Effect.gen(function* () {
      const body = indexBody(targets, stats, algorithm === "SHA-1" ? 20 : 32);
      const sum = yield* crypto.digest(algorithm, body);
      const file = new Uint8Array(body.length + sum.length);
      file.set(body);
      file.set(sum, body.length);
      const index = yield* gitPath(worktree, "index");
      const lock = `${index}.lock`;
      yield* fs.writeFile(lock, file, { flag: "wx", mode: 0o666 });
      yield* fs
        .rename(lock, index)
        .pipe(Effect.tapError(() => fs.remove(lock).pipe(Effect.ignore)));
    });

  const resetToPlainCheckout = Effect.fn("CloneCheckout.resetToPlainCheckout")(
    function* (worktree: string) {
      const entries = yield* fs
        .readDirectory(worktree)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of entries) {
        if (name !== ".git") {
          yield* forceRemove(path.join(worktree, name)).pipe(Effect.ignore);
        }
      }
      yield* git.run(worktree, ["read-tree", "--reset", "-u", "HEAD"]);
    },
  );

  // Runs post-checkout as `git worktree add` does after its checkout:
  // every hook `git hook list` names, in its order, in the new worktree,
  // with GIT_DIR and GIT_WORK_TREE unset. `git hook run` would export
  // GIT_DIR, which points a hook's git in other repositories at this one.
  const runPostCheckoutHook = (worktree: string, head: string) =>
    Effect.gen(function* () {
      const args = ["0".repeat(head.length), head, "1"];
      // Most repos have no hooks: `hook list` says so before anything else
      // is asked.
      const hooksDir = yield* Effect.cached(gitPath(worktree, "hooks"));
      const listed = yield* git
        .run(worktree, ["hook", "list", "-z", "post-checkout"])
        .pipe(Effect.result);
      let list: string;
      if (Result.isSuccess(listed)) list = listed.success;
      else if (
        listed.failure instanceof Git.GitCommandError &&
        Git.stderrOf(listed.failure).includes("no hooks found")
      ) {
        return;
      } else {
        // A git without `hook list` has no config hooks either, only the
        // hooks folder's, which runs when it's executable.
        const hook = yield* fs
          .stat(path.join(yield* hooksDir, "post-checkout"))
          .pipe(Effect.option);
        list =
          Option.isSome(hook) && (hook.value.mode & 0o111) !== 0
            ? "hook from hookdir"
            : "";
      }
      const names = splitZ(list);
      if (names.length === 0) return;
      const execPath = (yield* git.run(worktree, ["--exec-path"])).trim();
      const dir = yield* fs
        .realPath(worktree)
        .pipe(Effect.orElseSucceed(() => worktree));
      const searched = yield* env("PATH");
      // The environment git gives its hooks: its exec path exported and
      // first on PATH, no prefix.
      const hookEnv = {
        GIT_EXEC_PATH: execPath,
        GIT_PREFIX: "",
        PATH: `${execPath}:${searched}`,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        SHIGOMORI_CD_FILE: undefined,
      };
      const runOne = (command: string, commandArgs: ReadonlyArray<string>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, [...commandArgs], {
                cwd: dir,
                env: hookEnv,
                extendEnv: true,
                stdin: "ignore",
              }),
            );
            const output = yield* handle.all.pipe(
              Stream.decodeText(),
              Stream.mkString,
              Effect.orElseSucceed(() => ""),
            );
            const code = yield* handle.exitCode;
            return { code: Number(code), output };
          }),
        );
      const run = (command: string, commandArgs: ReadonlyArray<string>) =>
        runOne(command, commandArgs).pipe(
          // A script without a #! line, which git hands to sh as a shell
          // would.
          Effect.catchIf(
            (error) =>
              Predicate.isTagged(error, "PlatformError") &&
              String(error.cause ?? "").includes("ENOEXEC"),
            () => runOne("/bin/sh", [command, ...commandArgs]),
          ),
          Effect.map(({ code, output }) =>
            code === 0
              ? Option.none<HookFailed>()
              : Option.some(
                  new HookFailed({
                    cause: new Error(output.trim() || `exit status ${code}`),
                  }),
                ),
          ),
          Effect.catch((error) =>
            Effect.succeed(Option.some(new HookFailed({ cause: error }))),
          ),
        );
      // Like git, every hook runs even after one fails, and the first
      // failure is the result.
      let first: HookFailed | undefined;
      for (const name of names) {
        let failed: Option.Option<HookFailed>;
        if (name === "hook from hookdir") {
          failed = yield* run(
            path.join(yield* hooksDir, "post-checkout"),
            args,
          );
        } else {
          // A config hook's command goes through the shell with the hook's
          // arguments after it, as git runs it. The last value wins.
          const commands = yield* git
            .run(worktree, [
              "config",
              "-z",
              "--get-all",
              `hook.${name}.command`,
            ])
            .pipe(Effect.option);
          if (Option.isNone(commands)) continue;
          const values = splitZ(commands.value);
          const command = values.at(-1) ?? "";
          failed = yield* run("/bin/sh", [
            "-c",
            `${command} "$@"`,
            command,
            ...args,
          ]);
        }
        if (first === undefined && Option.isSome(failed)) first = failed.value;
      }
      if (first !== undefined) return yield* first;
    });

  const finish = Effect.fn("CloneCheckout.finish")(function* (input: {
    readonly source: string;
    readonly worktree: string;
  }) {
    const outcome = yield* clone(input.source, input.worktree).pipe(
      Effect.result,
    );
    if (Result.isFailure(outcome)) {
      yield* resetToPlainCheckout(input.worktree).pipe(
        Effect.mapError(
          (cause) => new CheckoutUnfinished({ path: input.worktree, cause }),
        ),
      );
    }
    const head = (yield* git.run(input.worktree, ["rev-parse", "HEAD"])).trim();
    yield* runPostCheckoutHook(input.worktree, head);
    return outcome;
  });

  // Why the project's checkouts can't be cloned from, none when they can.
  // A sparse checkout's new worktree is sparse too, which only git lays
  // out, and a split index keeps entries whose raciness cutoff isn't the
  // index's own.
  const sparseOrSplit = (checkout: string) =>
    Effect.gen(function* () {
      return (
        (yield* configBool(checkout, "core.sparseCheckout")) ||
        (yield* configBool(checkout, "core.splitIndex"))
      );
    });

  const projectBlocked = (repo: string) =>
    Effect.gen(function* () {
      if (yield* sparseOrSplit(repo)) return true;
      // Replacement objects change what a blob reads as, so the source's
      // files needn't hold what a checkout writes now.
      if ((yield* env("GIT_NO_REPLACE_OBJECTS")) !== "") return false;
      const useReplace = yield* configValue(repo, [
        "--bool",
        "core.useReplaceRefs",
      ]);
      const base = yield* env("GIT_REPLACE_REF_BASE");
      const refs = yield* git
        .run(repo, [
          "for-each-ref",
          "--count=1",
          "--format=x",
          base === "" ? "refs/replace/" : base,
        ])
        .pipe(Effect.orElseSucceed(() => ""));
      return !Option.contains(useReplace, "false") && refs.trim() !== "";
    });

  // Whether a checkout can be cloned from into `destination`: on the
  // same APFS volume, neither sparse nor split.
  const sourceUsable = (source: string, destination: string) =>
    Effect.gen(function* () {
      const [from, parent] = yield* Effect.all([
        fs.stat(source).pipe(Effect.option),
        fs.stat(path.dirname(destination)).pipe(Effect.option),
      ]);
      if (Option.isNone(from) || Option.isNone(parent)) return false;
      if (from.value.dev !== parent.value.dev) return false;
      const types = yield* darwin.fsType({ root: source }).pipe(
        Stream.runCollect,
        Effect.orElseSucceed(() => []),
      );
      const type = types[0];
      if (type === undefined || Darwin.isFailed(type) || type.type !== "apfs") {
        return false;
      }
      return !(yield* sparseOrSplit(source));
    });

  const pickSource = Effect.fn("CloneCheckout.pickSource")(function* (input: {
    readonly repo: string;
    readonly checkouts: ReadonlyArray<CloneSource>;
    readonly destination: string;
    readonly baseBranch: string;
  }) {
    if (yield* projectBlocked(input.repo)) return Option.none<CloneSource>();
    // In carry-over's order: the checkout on the base branch, the
    // primary, then the rest by name.
    const ordered = orderSources(
      input.checkouts,
      input.destination,
      input.baseBranch,
    );
    for (const source of ordered) {
      if (yield* sourceUsable(source.path, input.destination)) {
        return Option.some(source);
      }
    }
    return Option.none<CloneSource>();
  });

  const forget = Effect.fn("CloneCheckout.forget")(function* (
    worktreeId: string,
  ) {
    yield* sql`DELETE FROM clone_verified WHERE source_id = ${worktreeId}`.pipe(
      Effect.ignore,
    );
  });

  return CloneCheckout.of({
    pickSource,
    finish,
    clone,
    resetToPlainCheckout,
    forget,
  });
});

export const layer = Layer.effect(CloneCheckout, make);
