// The app's side of a data-folder move (the engine's dataDirMove.ts,
// which owns its steps, its journal and its recovery): where the folder
// goes, the refusals only the host can make, the scripts and the updater
// held, the copy to another volume, and what holds the folder let go.
import { installingWords } from "@host/lib/Shell";
import { cp, mkdir, open, readdir, rmdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import {
  isSameOrInside,
  trimTrailingSlashes,
} from "@shigomori/contracts/projectPaths";
import { callFailureOf, errorMessageOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DataDirMove from "@shigomori/engine/dataDirMove";
import * as Entries from "@shigomori/engine/entries";
import { byPlatform } from "@shigomori/engine/platform";
import { exec } from "@shigomori/engine/processes";
import { busyRefusal } from "@shared/busy";
import { hostCallFailure } from "./Engine";
import * as Scripts from "./Scripts";
import {
  canonicalDataDirName,
  dataDir,
  dataDirPointerPath,
  defaultDataDir,
  expandHome,
  isENOENT,
  legacyDataDirPointerPath,
} from "@shared/paths";

// A step on the file system, its failure as it crosses a wire.
const fsStep = <A>(step: () => Promise<A>) =>
  Effect.tryPromise({ try: step, catch: callFailureOf });
// A move refused before anything moved.
class DataDirMoveError extends Schema.TaggedError<DataDirMoveError>()(
  "DataDirMoveError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// Where this session's data dir is, and where a move of it writes: its
// pointer and the pre-2.0 one it clears, the default location (which
// needs no pointer) and the flavor's name for the folder. Refused when
// the data dir was overridden, since a pointer would then be ignored.
export type DataDirPlace = {
  readonly dataDir: string;
  readonly pointerFile: string;
  readonly legacyPointerFile: string | null;
  readonly defaultDataDir: string;
  readonly dataDirName: string;
};

export const sessionPlace = Effect.try({
  try: (): DataDirPlace => ({
    dataDir: dataDir(),
    pointerFile: dataDirPointerPath(),
    legacyPointerFile: legacyDataDirPointerPath(),
    defaultDataDir: defaultDataDir(),
    dataDirName: canonicalDataDirName(),
  }),
  catch: (error) =>
    new DataDirMoveError({
      reason: errorMessageOf(error),
    }),
});

// The tree at `from` copied to `to`, symlinks (carry-over entries) as
// links rather than followed.
const copyTree = (from: string, to: string) =>
  byPlatform({
    darwin: nodeCopy,
    linux: nodeCopy,
    win32: copyOwnersOnly,
  })(from, to);

const nodeCopy = (from: string, to: string) =>
  fsStep(() => cp(from, to, { recursive: true, verbatimSymlinks: true }));

// On Windows by the engine's copy, which keeps a junction a junction,
// into a folder made the owner's alone first: what is copied in takes
// its folder's access, and another drive's root lets every account of
// the machine read what is under it.
// The store's shared-memory index stays behind: SQLite holds it locked
// while the store is open, and builds it again from the WAL when the
// copy opens.
const copyOwnersOnly = (from: string, to: string) =>
  Effect.gen(function* () {
    yield* fsStep(() => mkdir(to));
    yield* exec("icacls", [
      to,
      "/inheritance:r",
      "/grant:r",
      "*S-1-3-4:(OI)(CI)F",
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
  });

// A file or folder flushed to disk (on macOS, past the drive's cache).
const flush = async (at: string, flag: "r" | "r+" = "r") => {
  const handle = await open(at, flag);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

// Windows flushes a file only through a handle that may write it, so a
// read-only one (git's objects) reaches the disk with the cache's next
// writes, seconds later.
const flushFile = (file: string) =>
  byPlatform({
    darwin: () => flush(file),
    linux: () => flush(file),
    win32: async () => {
      if (((await stat(file)).mode & 0o200) !== 0) await flush(file, "r+");
    },
  })();

const entryPath = (entry: {
  readonly parentPath: string;
  readonly name: string;
}) => join(entry.parentPath, entry.name);
const depth = (folder: string) => folder.split("/").length;

// Every file and folder of the tree at `dir` flushed, each folder after
// what it holds; a link is its folder's entry, flushed with it. Windows
// can't flush a folder (the engine's dataDirMove.ts says what that
// leaves).
const flushTree = (dir: string) =>
  Effect.gen(function* () {
    const entries = yield* fsStep(() =>
      readdir(dir, { recursive: true, withFileTypes: true }),
    );
    yield* Effect.forEach(
      entries.filter((entry) => entry.isFile()).map(entryPath),
      (file) => fsStep(() => flushFile(file)),
      { concurrency: 32, discard: true },
    );
    yield* byPlatform({
      darwin: flushFolders,
      linux: flushFolders,
      win32: () => Effect.void,
    })(dir, entries);
  });

const flushFolders = (dir: string, entries: ReadonlyArray<Dirent>) =>
  Effect.forEach(
    [
      ...entries.filter((entry) => entry.isDirectory()).map(entryPath),
      dir,
    ].toSorted((a, b) => depth(b) - depth(a)),
    (folder) => fsStep(() => flush(folder)),
    { discard: true },
  );

export const moveDataDir = Effect.fnUntraced(function* <E, R>(
  // The new parent, or undefined to reset to the default location.
  parentDir: string | undefined,
  opts: {
    readonly place: DataDirPlace;
    // The caller closes its fs watchers on the data dir here, before the
    // rename -- they're moot anyway, the app relaunches after the move.
    readonly beforeMove: Effect.Effect<void, E, R>;
    // The updater let go of the data folder, or the version an install
    // under way restarts into (Shell.holdUpdater).
    readonly holdUpdater: Effect.Effect<string | null, never, R>;
    // Every script's kill chain, waited for (Scripts.stopAll).
    readonly killAllScripts: Effect.Effect<void, never, R>;
    // Whether a worktree is being sent or brought here, and the devices
    // bringing one from here, by name (host/lib/sync/Moves): files a
    // copy would miss. Asked once the move holds the lock, so one that
    // starts after is refused by it instead.
    readonly movesUnderWay: Effect.Effect<{
      readonly moving: boolean;
      readonly bringing: ReadonlyArray<string>;
    }>;
    // The copy to another volume and its hold on the store, where a
    // proof stops it.
    readonly copy?: (
      from: string,
      to: string,
    ) => Effect.Effect<void, unknown, R>;
  },
) {
  const { place } = opts;
  const oldDir = place.dataDir;
  const path = yield* Path.Path;
  const parent =
    parentDir === undefined
      ? path.dirname(place.defaultDataDir)
      : expandHome(parentDir);
  // Never resolve against the process cwd: a relative parent would land
  // the data dir somewhere the user never saw.
  if (!path.isAbsolute(parent)) {
    return yield* new DataDirMoveError({
      reason: `The new parent folder must be an absolute path: ${parentDir}`,
    });
  }
  const newDir = path.join(parent, place.dataDirName);
  const fs = yield* FileSystem.FileSystem;
  const oldReal = yield* fs
    .realPath(oldDir)
    .pipe(Effect.orElseSucceed(() => oldDir));
  const spellings = [trimTrailingSlashes(oldDir), trimTrailingSlashes(oldReal)];
  // A rename would move the link and leave its target where it is.
  const link = yield* fs
    .readLink(trimTrailingSlashes(oldDir))
    .pipe(Effect.option);
  if (Option.isSome(link)) {
    return yield* new DataDirMoveError({
      reason: `The data folder is a link to ${oldReal}. Move that folder instead.`,
    });
  }
  if (spellings.some((dir) => isSameOrInside(newDir, dir))) {
    return yield* new DataDirMoveError({
      reason:
        newDir === oldDir
          ? `The data folder is already at ${oldDir}.`
          : `Can't move the data folder inside itself (${oldDir}).`,
    });
  }
  // Running scripts are reaped below (same semantics as nuke), but
  // in-flight destructive lifecycle work (worktree/project deletes,
  // delegated engine runs) is mid-write inside the data dir and can't be
  // safely killed or moved under. Refuse instead.
  const scripts = yield* Scripts.Scripts;
  const refused = busyRefusal({
    ...(yield* scripts.busy),
    runningScripts: 0,
    busyTerminals: 0,
    queuedMoves: 0,
  });
  if (refused !== null) {
    return yield* new DataDirMoveError({ reason: refused });
  }
  yield* fsStep(() => mkdir(parent, { recursive: true }));
  const newReal = path.join(
    yield* fs.realPath(parent).pipe(Effect.orElseSucceed(() => parent)),
    place.dataDirName,
  );

  const ready = Effect.gen(function* () {
    const underWay = yield* opts.movesUnderWay;
    if (underWay.moving) {
      return yield* new DataDirMoveError({
        reason:
          "A worktree is still being sent or brought here. Try again when it finishes.",
      });
    }
    if (underWay.bringing.length > 0) {
      const one = underWay.bringing.length === 1;
      return yield* new DataDirMoveError({
        reason: `${underWay.bringing.join(" and ")} ${one ? "is" : "are"} bringing a worktree from here. Try again when ${one ? "it finishes" : "they finish"}.`,
      });
    }
    yield* fsStep(() =>
      // Clear an existing empty placeholder before the rename. A non-empty
      // directory is refused, never merged into.
      rmdir(newDir).catch((err: NodeJS.ErrnoException) => {
        if (isENOENT(err)) return;
        if (err.code === "ENOTEMPTY" || err.code === "EEXIST") {
          throw new Error(`${newDir} already exists and is not empty.`);
        }
        throw err;
      }),
    );
    // The last check: an install under way restarts the app out of this
    // folder, and refuses. Past it, no check or install starts.
    const updating = yield* opts.holdUpdater;
    if (updating !== null) {
      return yield* new DataDirMoveError({
        reason: `${installingWords(updating)} Move the data folder after the restart.`,
      });
    }
    // Scripts running inside the worktrees we're about to move would
    // keep cwds pointing at the old location. Reap them first.
    yield* opts.killAllScripts;
  });

  yield* DataDirMove.moveDataDir(
    {
      from: oldDir,
      spellings,
      to: newDir,
      toReal: newReal,
      pointerFile: place.pointerFile,
      legacyPointerFile: place.legacyPointerFile,
      toDefault: newDir === place.defaultDataDir,
    },
    {
      ready,
      // Marked delete-inflight, so no script run lands in a directory
      // mid-move, as in a nuke.
      holding: (ids) => scripts.deleting(ids, "move"),
      releasing: opts.beforeMove,
      copy: (from: string, to: string) =>
        Effect.gen(function* () {
          yield* opts.copy === undefined
            ? DataDirMove.holdingStore(copyTree(from, to))
            : opts.copy(from, to);
          yield* flushTree(to);
        }),
    },
  ).pipe(Effect.mapError(hostCallFailure));
});
