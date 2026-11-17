// Whole folder entries: whether one is there, whether it is a folder,
// copying a tree as `cp` does, linking a folder and removing an empty
// one. The calls Effect's FileSystem lacks (rmdir, a link's type, lstat)
// are Node's, as in executables.ts.
import { rmdir, symlink } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { CopyFailed } from "./entries/documents.ts";
import { copyEntries } from "./entries/windows.ts";
import { byFamily } from "./platform.ts";
import { exec } from "./processes.ts";
import { errorMessageOf } from "@shigomori/contracts/errors";

export { copyEntries } from "./entries/windows.ts";

// Whether anything is at a path: a file, a folder, or a symlink, a
// dangling one included.
export const entryExists = (fs: FileSystem.FileSystem, file: string) =>
  fs.readLink(file).pipe(
    Effect.as(true),
    Effect.catch(() => fs.exists(file)),
    Effect.orElseSucceed(() => false),
  );

// Whether a folder is at a path, through a symlink to one too.
export const isDirectory = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );

// A stat's mtime, epoch ms, 0 when it has none.
export const mtimeOf = (info: FileSystem.File.Info) =>
  Option.match(info.mtime, {
    onNone: () => 0,
    onSome: (date) => date.getTime(),
  });

// What the copy said, for a report that carries it.
export const copyFailure = (error: CopyFailed): string =>
  errorMessageOf(error.cause);

// A tree copied to a destination that isn't there, to be renamed to
// `landsAt`, a link as a link. `keepTimes` keeps the times and modes
// too, which a volume that can't hold them fails.
export const copyTree = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  from: string,
  to: string,
  landsAt: string,
  options: { readonly keepTimes?: boolean } = {},
) => {
  const keepTimes = options.keepTimes === true;
  const cp = () => cpTree(spawner, from, to, keepTimes);
  return byFamily({
    posix: cp,
    windows: () => copyEntries(from, to, landsAt, keepTimes),
  })();
};

// `cp -R -P`, `-p` to keep the times and modes.
const cpTree = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  from: string,
  to: string,
  keepTimes: boolean,
) =>
  Effect.gen(function* () {
    const { stdout, code } = yield* exec(
      "cp",
      ["-R", "-P", ...(keepTimes ? ["-p"] : []), from, to],
      { all: true, anyExit: true },
    );
    if (code !== 0) {
      return yield* new CopyFailed({
        to,
        cause: new Error(stdout.trim() || `cp exited with ${code}`),
      });
    }
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    // A cp that never started, in the platform's words.
    Effect.catchTag("CommandError", ({ cause }) =>
      Effect.fail(new CopyFailed({ to, cause })),
    ),
  );

// A link at `at` to the folder `target`: on Windows a junction, which
// needs none of the privilege a symbolic link does there.
export const linkFolder = (target: string, at: string) =>
  Effect.tryPromise({
    try: () => symlink(target, at, "junction"),
    catch: errorMessageOf,
  });

// rmdir, which takes only an empty folder: something written there
// since keeps it. Answers whether it went. Windows has no rmdir program.
export const removeEmptyFolder = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  dir: string,
) =>
  byFamily({
    posix: rmdirCommand,
    windows: () =>
      Effect.promise(() =>
        rmdir(dir).then(
          () => true,
          () => false,
        ),
      ),
  })(spawner, dir);

const rmdirCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  dir: string,
) =>
  spawner.exitCode(ChildProcess.make("rmdir", [dir])).pipe(
    Effect.map((code) => code === 0),
    Effect.orElseSucceed(() => false),
  );
