// A data-folder move's copy and flush on a Mac and on Linux.
import { cp } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { entryPath, flushFiles, fsStep, synced } from "./files";

// On macOS past the drive's cache.
const flush = (at: string) => synced(at, "r");

const depth = (folder: string) => folder.split("/").length;

export const posix = {
  // Symlinks (carry-over entries) copied as links rather than followed.
  copyTree: (from: string, to: string) =>
    fsStep(() => cp(from, to, { recursive: true, verbatimSymlinks: true })),

  // Every file and folder, each folder after what it holds. A link is
  // its folder's entry, flushed with it.
  flushTree: (dir: string) =>
    Effect.gen(function* () {
      const entries = yield* flushFiles(dir, flush);
      yield* Effect.forEach(
        [
          ...entries.filter((entry) => entry.isDirectory()).map(entryPath),
          dir,
        ].toSorted((a, b) => depth(b) - depth(a)),
        (folder) => fsStep(() => flush(folder)),
        { discard: true },
      );
    }),
};
