// The clone itself: the source's files cloned into the worktree,
// checked, and its index written.
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Darwin from "../Darwin.ts";
import * as Git from "../Git.ts";
import {
  ancestors,
  checkoutConverts,
  type IndexStat,
  indexBody,
  indexStatOf,
  parseLsFilesDebug,
  parseLsTree,
  type SourceEntry,
  type TreeEntry,
  verifiedRecord,
} from "../gitIndex.ts";
import * as Paths from "../Paths.ts";
import { CloneFailed, LEFT_TO_GIT, sameConversions } from "./documents.ts";
import {
  attributeCutoffs,
  attributeLooks,
  caseCollisions,
  clonablePaths,
  planUnits,
  stale,
  verdicts,
} from "./plan.ts";
import type { ReadsArea } from "./reads.ts";
import type { VerifiedArea } from "./verified.ts";

const fail = (reason: CloneFailed["reason"]) => (cause: unknown) =>
  new CloneFailed({ reason, cause });

export const makeCloning = ({
  reads: { configHome, umask, lstatUnder, lstatAll, readConversions, blobId },
  verified: { recordsOf, keepRecords },
}: {
  readonly reads: ReadsArea;
  readonly verified: VerifiedArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const darwin = yield* Darwin.Darwin;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const paths = yield* Paths.Paths;

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
              if (
                !Darwin.isFailed(entry) &&
                (entry.mode & Darwin.S_IFMT) === Darwin.S_IFDIR
              ) {
                yield* fs
                  .chmod(path.join(target, entry.path), 0o700)
                  .pipe(Effect.ignore);
              }
            }
            yield* fs.remove(target, { recursive: true, force: true });
          }),
        ),
      );

    const clone = Effect.fn("CloneCheckout.clone")(function* (
      source: string,
      worktree: string,
    ) {
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
        const index = yield* git.gitPath(source, "index");
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
        const infoAttrs = yield* git.gitPath(source, "info/attributes");
        const origins = yield* git
          .run(source, [
            "config",
            "--list",
            "--show-origin",
            "--name-only",
            "-z",
          ])
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
          others: git.run(source, [
            "ls-files",
            "-z",
            "--others",
            "--directory",
          ]),
          conversions: readConversions(source, worktree, targetPaths),
          sizes: git.run(
            worktree,
            [
              "cat-file",
              "--buffer",
              "--batch-check=%(objectname) %(objectsize)",
            ],
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
        format === "sha1"
          ? "SHA-1"
          : format === "sha256"
            ? "SHA-256"
            : undefined;
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
      const clonable = clonablePaths({
        targets,
        bySourcePath,
        blobSize,
        converted,
        symlinks: reads.conversions.config.symlinks,
        collides: caseCollisions(targets),
        indexSec: reads.index.sec,
        indexNsec: reads.index.nsec,
      });
      const { units, parents, targetDirs, tracked } = planUnits({
        targets,
        sourceEntries,
        others: reads.others.split("\0"),
        clonable,
      });
      yield* Effect.forEach(
        parents,
        (parent) =>
          fs.makeDirectory(path.join(worktree, parent), { recursive: true }),
        { concurrency: 8, discard: true },
      ).pipe(Effect.mapError(fail("clone")));
      const cloned = yield* darwin
        .clone({ from: source, to: worktree, paths: units })
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
        units.filter((unit) => targetDirs.has(unit)),
        tracked,
        targetDirs,
        0o777 & ~mask,
      ).pipe(Effect.mapError(fail("clone")));

      const { folders, toLstat } = attributeLooks(
        source,
        clonable,
        reads.attributeFiles,
      );
      const { newest, attrsChanged, realDir } = attributeCutoffs(
        source,
        folders,
        reads.attributeFiles,
        yield* lstatAll(toLstat),
      );
      // Attributes that changed while this ran may make a checkout write
      // what the conversion checks didn't expect. They're read again: git
      // checks out with the ones in force now if they differ.
      if (newest >= started) {
        const again = yield* readConversions(
          source,
          worktree,
          targetPaths,
        ).pipe(Effect.option);
        if (
          Option.isNone(again) ||
          !sameConversions(again.value, reads.conversions)
        ) {
          return yield* new CloneFailed({ reason: "attributes-changed" });
        }
      }

      const clonableList = [...clonable];
      const verified = clonableList.some((p) =>
        stale(p, bySourcePath, attrsChanged),
      )
        ? yield* recordsOf(source)
        : new Map<string, string>();

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
      const { kept, rejected, toHash } = verdicts({
        clonable: clonableList,
        bySourcePath,
        sourceStats,
        cloneStats,
        sourceXattrs,
        realDir,
        mask,
        attrsChanged,
        verified,
      });
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
    const pruneUntracked = Effect.fnUntraced(function* (
      worktree: string,
      dirs: ReadonlyArray<string>,
      tracked: ReadonlySet<string>,
      targetDirs: ReadonlySet<string>,
      dirMode: number,
    ) {
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
                // A unit that never landed has nothing to prune. A folder
                // the walk couldn't read may hold what must go.
                if (Darwin.isFailed(entry)) {
                  if (entry.error.code === "ENOENT") continue;
                  return Effect.fail(entry.error);
                }
                const rel = entry.path === "." ? unit : `${unit}/${entry.path}`;
                if ([...ancestors(rel)].some((dir) => goneSet.has(dir))) {
                  continue;
                }
                const isDir = (entry.mode & Darwin.S_IFMT) === Darwin.S_IFDIR;
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
    const writeIndex = Effect.fnUntraced(function* (
      worktree: string,
      targets: ReadonlyArray<TreeEntry>,
      stats: ReadonlyMap<string, IndexStat>,
      algorithm: "SHA-1" | "SHA-256",
    ) {
      const body = indexBody(targets, stats, algorithm === "SHA-1" ? 20 : 32);
      const sum = yield* crypto.digest(algorithm, body);
      const file = new Uint8Array(body.length + sum.length);
      file.set(body);
      file.set(sum, body.length);
      const index = yield* git.gitPath(worktree, "index");
      const lock = `${index}.lock`;
      yield* fs.writeFile(lock, file, { flag: "wx", mode: 0o666 });
      yield* fs
        .rename(lock, index)
        .pipe(Effect.tapError(() => fs.remove(lock).pipe(Effect.ignore)));
    });

    return { forceRemove, clone };
  });
