// Whole folder entries: whether one is there, and copying a tree as
// `cp` does.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

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
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("cp", ["-R", "-P", ...flags, from, to]),
      );
      const said = yield* handle.all.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.orElseSucceed(() => ""),
      );
      const code = yield* handle.exitCode;
      if (code !== 0) {
        return yield* new CopyFailed({
          to,
          cause: new Error(said.trim() || `cp exited with ${code}`),
        });
      }
    }),
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new CopyFailed({ to, cause })),
    }),
  );
