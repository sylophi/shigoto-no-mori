// A data-folder move's copy and flush on Windows.
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as Entries from "@shigomori/engine/entries";
import { exec } from "@shigomori/engine/processes";
import { flushFiles, fsStep, synced } from "./files";

// Windows flushes a file only through a handle that may write it, so a
// read-only one (git's objects) is made writable for its flush.
const flushFile = async (file: string) => {
  const { mode } = await stat(file);
  if ((mode & 0o200) !== 0) return synced(file, "r+");
  await chmod(file, mode | 0o200);
  try {
    await synced(file, "r+");
  } finally {
    await chmod(file, mode);
  }
};

export const windows = {
  // By the engine's copy, which keeps a junction a junction, into a
  // folder made the user's alone first: what is copied in takes its
  // folder's access, and another drive's root lets every account of the
  // machine read what is under it. The user by name, since a move run
  // elevated makes the Administrators group the owner of what it writes.
  // The store's shared-memory index stays behind: SQLite holds it locked
  // while the store is open, and builds it again from the WAL when the
  // copy opens.
  copyTree: (from: string, to: string) =>
    Effect.gen(function* () {
      yield* fsStep(() => mkdir(to));
      yield* exec("icacls", [
        to,
        "/inheritance:r",
        "/grant:r",
        `${userInfo().username}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ]).pipe(Effect.mapError(callFailureOf));
      const names = yield* fsStep(() => readdir(from));
      yield* Effect.forEach(
        names.filter((name) => name !== "store.db-shm"),
        (name) =>
          Entries.copyEntries(join(from, name), join(to, name), true).pipe(
            Effect.mapError(callFailureOf),
          ),
        { discard: true },
      );
    }),

  // Every file. A folder can't be flushed (the engine's dataDirMove.ts
  // says what that leaves).
  flushTree: (dir: string) => Effect.asVoid(flushFiles(dir, flushFile)),
};
