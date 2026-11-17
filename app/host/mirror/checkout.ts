// A mirror's copy reads and writes its files the way its original's
// checkout does. The original's device reads that checkout as the
// mirror starts (sessions.ts), and the copy's landing
// (host/lib/sync/landing.ts) refuses the links its device can't make
// and gives the copy's worktree what its repo wouldn't give it alone.
// Once the original's files are over it, the copy's index is told
// their sizes (clearStaleSizes).
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { SyncCheckout } from "@shigomori/contracts/modules/sync";
import type { Project } from "@shigomori/contracts/schemas";
import { symlinksRefusal } from "@shared/pullCollision";
import * as Git from "@shigomori/engine/Git";
import { splitZ } from "@shigomori/engine/gitParse";
import * as Layout from "@shigomori/engine/Layout";
import { byFamily } from "@shigomori/engine/platform";

// A script whose #! line ends in CRLF, which a shell outside Windows
// reads as part of the interpreter's name.
const crlfShebang = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const head = yield* (yield* fs.open(file, { flag: "r" })).readAlloc(256);
    return Option.exists(head, (bytes) =>
      /^#![^\n]*\r\n/.test(Buffer.from(bytes).toString("latin1")),
    );
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => false),
  );

// How the original reads and writes its files, which its copy takes,
// and whether its scripts would start on Windows alone. Only a Windows
// checkout gives them CRLF where the repo doesn't.
export const readOriginal = Effect.fnUntraced(function* (worktreePath: string) {
  const git = yield* Git.Git;
  const path = yield* Path.Path;
  const [config, index] = yield* Effect.all(
    [
      git.checkoutConfig(worktreePath),
      git.run(worktreePath, [
        "ls-files",
        "-z",
        "--format=%(objectmode) %(path)",
      ]),
    ],
    { concurrency: 2 },
  );
  const entries = splitZ(index);
  return {
    checkout: {
      ...config,
      tracksSymlinks: entries.some((entry) => entry.startsWith("120000 ")),
    } satisfies SyncCheckout,
    crlfScripts: yield* byFamily({
      posix: Effect.succeed(false),
      windows: Effect.map(
        Effect.findFirst(entries, (entry) =>
          entry.startsWith("100755 ")
            ? crlfShebang(path.join(worktreePath, entry.slice(7)))
            : Effect.succeed(false),
        ),
        Option.isSome,
      ),
    }),
  };
});

class SymlinksRefusedError extends Schema.TaggedError<SymlinksRefusedError>()(
  "SymlinksRefusedError",
  { dir: Schema.String },
) {
  override get message(): string {
    return symlinksRefusal(this.dir, byFamily({ posix: false, windows: true }));
  }
}

// Whether a symlink can be made in `dir`, made first if missing.
const symlinksHold = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(dir, { recursive: true });
    const probe = yield* fs.makeTempDirectoryScoped({ directory: dir });
    return yield* fs.symlink("target", path.join(probe, "link")).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  }).pipe(Effect.scoped);

// The copy writes the original's symlinks as links, which the folder
// the project's worktrees go in must hold.
export const refuseUnmakeableSymlinks = Effect.fnUntraced(function* (
  project: Project,
  checkout: SyncCheckout | undefined,
) {
  if (checkout?.symlinks !== true || !checkout.tracksSymlinks) return;
  const dir = yield* (yield* Layout.Layout).worktreeBase(project);
  if (!(yield* symlinksHold(dir))) {
    return yield* new SymlinksRefusedError({ dir });
  }
});

// The original's settings for the copy's worktree alone, none when the
// copy's repo gives a new worktree the same, so its config stays as it
// was.
export const copyCheckoutConfig = Effect.fnUntraced(function* (
  project: Project,
  checkout: SyncCheckout | undefined,
) {
  if (checkout === undefined) return undefined;
  const own = yield* (yield* Git.Git).checkoutConfig(project.path);
  return own.autocrlf === checkout.autocrlf &&
    own.eol === checkout.eol &&
    own.symlinks === checkout.symlinks
    ? undefined
    : checkout;
});

// The copy's checkout recorded the size of each file as git wrote it,
// and the original's bytes the mirror wrote over it can differ in size
// with the same content: a file the original holds with LF where its
// checkout writes CRLF. git reads a tracked file whose size differs
// from the recorded one as modified without looking at its content, a
// refresh included, until it hashes the file again. So the paths git
// reads as changed by their stat alone are hashed again, which stages
// nothing: their content is the index's already. A submodule is never
// one, and `git diff` may be told to hide it.
export const clearStaleSizes = Effect.fnUntraced(function* (
  worktreePath: string,
) {
  const git = yield* Git.Git;
  const [byStat, byContent] = yield* Effect.all(
    [
      git.run(worktreePath, [
        "diff-files",
        "--name-only",
        "--ignore-submodules",
        "-z",
      ]),
      git.run(worktreePath, ["diff", "--name-only", "-z"]),
    ],
    { concurrency: 2 },
  );
  const changed = new Set(splitZ(byContent));
  const stale = splitZ(byStat).filter((file) => !changed.has(file));
  if (stale.length === 0) return;
  yield* git.withIndexLock(
    worktreePath,
    git.run(worktreePath, ["update-index", "-z", "--stdin"], {
      stdin: stale.map((file) => `${file}\0`).join(""),
    }),
  );
});
