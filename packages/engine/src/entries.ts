// Whole folder entries: whether one is there, and copying a tree as
// `cp` does.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as FileSystem from "effect/FileSystem";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { capture } from "./processes.ts";

// Whether anything is at a path: a file, a folder, or a symlink, a
// dangling one included.
export const entryExists = (fs: FileSystem.FileSystem, file: string) =>
  fs.readLink(file).pipe(
    Effect.as(true),
    Effect.catch(() => fs.exists(file)),
    Effect.orElseSucceed(() => false),
  );

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
  error.cause instanceof Error ? error.cause.message : String(error.cause);

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
