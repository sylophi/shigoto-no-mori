// Whether anything is at a path: a file, a folder, or a symlink, a
// dangling one included.
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

export const entryExists = (fs: FileSystem.FileSystem, file: string) =>
  fs.readLink(file).pipe(
    Effect.as(true),
    Effect.catch(() => fs.exists(file)),
    Effect.orElseSucceed(() => false),
  );
