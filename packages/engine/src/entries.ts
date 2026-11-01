// Whole folder entries: whether one is there, whether it is a folder,
// and copying a tree as `cp` does.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as FileSystem from "effect/FileSystem";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { capture } from "./processes.ts";
import { errorMessageOf } from "@shigomori/contracts/errors";

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

// A copy that didn't finish. cp's own words are the cause.
export class CopyFailed extends Schema.TaggedError<CopyFailed>()("CopyFailed", {
  to: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Couldn't copy to ${this.to}.`;
  }
}

// What cp said, for a report that carries it.
export const copyFailure = (error: CopyFailed): string =>
  errorMessageOf(error.cause);

// `cp -R -P` of a tree to a destination that isn't there, plus `flags`.
export const copyTree = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  from: string,
  to: string,
  flags: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const { output, code } = yield* capture(
      spawner,
      "cp",
      ["-R", "-P", ...flags, from, to],
      { from: "all" },
    );
    if (code !== 0) {
      return yield* new CopyFailed({
        to,
        cause: new Error(output.trim() || `cp exited with ${code}`),
      });
    }
  }).pipe(
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new CopyFailed({ to, cause })),
    }),
  );
