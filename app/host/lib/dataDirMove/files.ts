// What each OS's copy and flush of a data-folder move share.
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";

// A step on the file system, its failure as it crosses a wire.
export const fsStep = <A>(step: () => Promise<A>) =>
  Effect.tryPromise({ try: step, catch: callFailureOf });

// A file or folder flushed to disk through a handle opened with `flag`.
export const synced = async (at: string, flag: "r" | "r+") => {
  const handle = await open(at, flag);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const entryPath = (entry: {
  readonly parentPath: string;
  readonly name: string;
}) => join(entry.parentPath, entry.name);

// Every file of the tree at `dir` flushed by `flush`, and the tree's
// entries.
export const flushFiles = (
  dir: string,
  flush: (file: string) => Promise<void>,
) =>
  Effect.gen(function* () {
    const entries = yield* fsStep(() =>
      readdir(dir, { recursive: true, withFileTypes: true }),
    );
    yield* Effect.forEach(
      entries.filter((entry) => entry.isFile()).map(entryPath),
      (file) => fsStep(() => flush(file)),
      { concurrency: 32, discard: true },
    );
    return entries;
  });
