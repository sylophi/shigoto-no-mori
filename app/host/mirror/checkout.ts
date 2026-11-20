// A mirror's copy reads and writes its files the way its original's
// checkout does. The original's device reads that checkout as the
// mirror starts (sessions.ts), and the copy's landing
// (host/lib/sync/landing.ts) refuses the links its device can't make
// and gives the copy's worktree what its repo wouldn't give it alone.
// Once the other side's files are over a side's, its index is told
// their sizes (resetStaleSizes).
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

// A side's index recorded the size of each file as its own git wrote
// it, and the other side's bytes the mirror writes over it can differ
// in size with the same content: a file one side holds with LF where
// the other's checkout writes CRLF, or one either side checked out
// again. git reads a tracked file whose size differs from the recorded
// one as modified without looking at its content, a refresh included.
// So each path git reads as changed by its stat alone gets its index
// entry back as it was, the same blob without its stat, and the
// refresh then records the file's stat only where its content is that
// blob: a file edited since `git diff` looked reads modified, and
// nothing is staged. The blob is read just before it is written back,
// so a stage made in a terminal meanwhile is kept, and a path git
// printed in bytes that aren't UTF-8 is left alone, since it would come
// back as another path. A submodule is never one, and `git diff` may be
// told to hide it. Under the index lock, so a git follow's apply
// (gitState.ts) never lands between the read and the write.
export const resetStaleSizes = Effect.fnUntraced(function* (
  worktreePath: string,
) {
  const git = yield* Git.Git;
  yield* git.withIndexLock(
    worktreePath,
    Effect.gen(function* () {
      const changed = new Set(
        splitZ(yield* git.run(worktreePath, ["diff", "--name-only", "-z"])),
      );
      const parts = splitZ(
        yield* git.run(worktreePath, [
          "diff-files",
          "--ignore-submodules",
          "-z",
        ]),
      );
      let entries = "";
      // ":<index mode> <file mode> <index blob> <file blob> <status>",
      // then the path.
      for (let i = 0; i < parts.length; i += 2) {
        const [mode, , blob, , status] = (parts[i] ?? "").slice(1).split(" ");
        const file = parts[i + 1] ?? "";
        if (status === "M" && !changed.has(file) && !file.includes("\uFFFD")) {
          entries += `${mode} ${blob}\t${file}\0`;
        }
      }
      if (entries === "") return;
      yield* git.run(worktreePath, ["update-index", "-z", "--index-info"], {
        stdin: entries,
      });
      yield* git.refreshIndex(worktreePath);
    }),
  );
});
