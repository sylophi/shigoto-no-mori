// Moves the shigomori data dir to a new parent directory, or back to its
// default place: the folder moves under the flavor's name (.sm / .smd,
// which also renames a pre-2.0 ~/shigomori), and the pointer file
// (shared/packaging/cliDist.mts) records the new place for the app's and
// the CLI's next start, or goes when that place is the default, so a
// pointer always means a moved folder. The caller relaunches the app
// right after: the data dir is a boot-time constant every module has
// derived paths from.
//
// Two kinds of stored paths go stale and are carried along: worktree
// ids are hashes of the worktree's absolute path, so everything the
// engine keys by the id of every managed worktree under the data dir
// (marks, the worktree's data, a pending dirty capture) is re-keyed
// (the engine's rekey), and git's own worktree links are re-pointed by
// `git worktree repair`.
//
// The move is the one change under way: it holds the data-folder lock
// alone from its first step to its last (`DataDirLock`). A move a crash
// cuts short is finished or undone at the next start
// (resumeDataDirMove): the move keeps a journal in the data dir from
// before its re-key to its end, and a copy to another volume goes into a
// sibling of the destination, flushed to disk and renamed in only once
// whole.
//
// The journal (the engine's `dataDirMoveJournal.ts`) holds an entry per
// worktree that moves, marked `planned`, `rekeyed` or `returned`. A
// strict read takes an error as an error, never as absence: a capture
// ref git can't open or parse (`Git.readRef`), a journal that can't be
// read or decoded. The steps, and what a crash after each leaves:
//  0. The lock alone, waiting 30 s for the changes under way (one still
//     running refuses the move), then an earlier journal settled. Until
//     it is, the move is refused and the store keeps refusing writes.
//  1. Scripts killed, the pointer staged and flushed. A staged pointer
//     naming a folder that never came, which Paths ignores: its rescue
//     needs a journal.
//  2. The store refusing, then the journal, with no entries. Before the
//     journal, a refusing store with none, which the next settle lets
//     write; after it, an undo with nothing to reverse.
//  3. The plan: git's listing of each project's worktrees, made holding
//     the lock alone, so no create, adopt or move can change it. A
//     listing that fails refuses the move, unless the project's folder
//     is gone. As 2.
//  4. The preflight: nothing kept under any entry's new id (marks,
//     sessions, shelf, data rows, a capture read strictly), or the move
//     is refused. As 2.
//  5. The snapshot: each entry's capture, read strictly, and every entry
//     `planned`. An undo with nothing to reverse.
//  6. Each entry re-keyed (its rows in one transaction, the capture only
//     if it is the snapshot's, else the move fails), then marked
//     `rekeyed`. One re-keyed but still `planned` is reversed by the
//     undo, since only its re-key can have put anything under its new id
//     (2 and 4).
//  7. What holds the folder let go: the store's watcher, the updater's
//     bridge, the loopback's address file. As 6.
//  8. The folder moved and flushed: a rename, one step with its mark that
//     a cancel can't cut, or a copy, `partial` set first, holding the
//     store's write lock, every file and folder flushed past the drive's
//     cache, then renamed in. Before it, an undo at the source; after
//     it, the journal is at the destination with the pointer unmoved,
//     which Paths' rescue commits (a rename) or the source's journal
//     undoes (a copy).
//  9. The pointer committed, renamed in (or removed, for the default
//     place) and its folder flushed. Finished at the destination.
// 10. The finish: the engine's `finishMove`, here for git's links only
//     (`settle` false), then in full in the first engine graph to come
//     up at the new place (the doctor's doesn't settle). A crash leaves
//     it to the next one there, and a copy's old tree takes its space
//     until then.
//
// The finish and the undo (`undoMove`) are the engine's, in its
// dataDirMove.ts.
//
// Not covered: `SHIGOMORI_DATA_DIR` naming the folder a move moved still
// names the old place; a write from outside sm into a copy's old tree
// before the relaunch goes with the old tree; a copy can take a mirrored
// file mid-write (the peer's next cycle sends it again); under reftable
// a capture ref git can't open reads as absent.
import { installingWords } from "@host/lib/Shell";
import { cp, mkdir, open, readdir, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import { callFailureOf, errorMessageOf } from "@shigomori/contracts/errors";
import type { Project } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Types from "effect/Types";
import * as Ops from "./engineOps";
import { dirtyRef } from "@shigomori/engine/Dirty";
import { DataDirLock } from "@shigomori/engine/DataDirLock";
import * as Git from "@shigomori/engine/Git";
import { findProjectInsideDataDir, freshProjects } from "./projects";
import { busyRefusal } from "@shared/busy";
import * as Scripts from "./Scripts";
import {
  asMoveOwner,
  type Entry,
  finishMove,
  keptUnderNewId,
  rekeyForward,
  resumeDataDirMove,
  undoMove,
} from "@shigomori/engine/dataDirMove";
import {
  JOURNAL,
  type Journal,
  retireStore,
  reviveStore,
  writeJournal,
} from "@shigomori/engine/dataDirMoveJournal";
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
  fsStep(() => cp(from, to, { recursive: true, verbatimSymlinks: true }));

// A file or folder flushed to disk (on macOS, past the drive's cache).
const flush = async (at: string) => {
  const handle = await open(at, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const entryPath = (entry: {
  readonly parentPath: string;
  readonly name: string;
}) => join(entry.parentPath, entry.name);
const depth = (folder: string) => folder.split("/").length;

// Every file and folder of the tree at `dir` flushed, each folder after
// what it holds; a link is its folder's entry, flushed with it.
const flushTree = (dir: string) =>
  Effect.gen(function* () {
    const entries = yield* fsStep(() =>
      readdir(dir, { recursive: true, withFileTypes: true }),
    );
    yield* Effect.forEach(
      entries.filter((entry) => entry.isFile()).map(entryPath),
      (file) => fsStep(() => flush(file)),
      { concurrency: 32, discard: true },
    );
    yield* Effect.forEach(
      [
        ...entries.filter((entry) => entry.isDirectory()).map(entryPath),
        dir,
      ].toSorted((a, b) => depth(b) - depth(a)),
      (folder) => fsStep(() => flush(folder)),
      { discard: true },
    );
  });

const trimmed = (dir: string) => dir.replace(/\/+$/, "");

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
    // The copy to another volume, `copyTree` but where a proof stops it.
    readonly copy?: (
      from: string,
      to: string,
    ) => Effect.Effect<void, unknown, R>;
  },
) {
  const { place } = opts;
  const oldDir = place.dataDir;
  const pointerFile = place.pointerFile;
  const legacyPointerFile = place.legacyPointerFile;
  const parent =
    parentDir === undefined
      ? dirname(place.defaultDataDir)
      : expandHome(parentDir);
  // Never resolve against the process cwd: a relative parent would land
  // the data dir somewhere the user never saw.
  if (!isAbsolute(parent)) {
    return yield* new DataDirMoveError({
      reason: `The new parent folder must be an absolute path: ${parentDir}`,
    });
  }
  const newDir = join(parent, place.dataDirName);
  const toDefault = newDir === place.defaultDataDir;
  const fs = yield* FileSystem.FileSystem;
  const git = yield* Git.Git;
  // A file or folder flushed to disk (on macOS, past the drive's cache).
  const flushed = (at: string) =>
    Effect.scoped(
      Effect.flatMap(fs.open(at, { flag: "r" }), (handle) => handle.sync),
    ).pipe(Effect.mapError(callFailureOf));
  // git spells a path under a data folder reached through a link (/tmp,
  // /var/folders, a folder linked to another drive) by the link's
  // target, so a path counts as under it by either spelling.
  const oldReal = yield* fs
    .realPath(oldDir)
    .pipe(Effect.orElseSucceed(() => oldDir));
  const spellings = [trimmed(oldDir), trimmed(oldReal)];
  // A rename would move the link and leave its target where it is.
  const link = yield* fs.readLink(trimmed(oldDir)).pipe(Effect.option);
  if (Option.isSome(link)) {
    return yield* new DataDirMoveError({
      reason: `The data folder is a link to ${oldReal}. Move that folder instead.`,
    });
  }
  const underOld = (path: string) =>
    spellings.find((dir) => isSameOrInside(path, dir));

  if (underOld(newDir) !== undefined) {
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
  });
  if (refused !== null) {
    return yield* new DataDirMoveError({ reason: refused });
  }

  // Where git will name the moved worktrees: by the destination's real
  // spelling, which their new ids hash.
  yield* fsStep(() => mkdir(parent, { recursive: true }));
  const newReal = join(
    yield* fs.realPath(parent).pipe(Effect.orElseSucceed(() => parent)),
    place.dataDirName,
  );

  // Managed worktrees whose checkout sits under the data dir, as git
  // lists them while the move holds the lock alone (a create, an adopt
  // or a move anywhere can't change them after): their ids are marked
  // delete-inflight for the rest of the move (blocking a renderer script
  // run from landing in a directory mid-move, exactly like the nuke
  // flow), what they keep re-keyed, and their git links repaired
  // afterwards. Listed before anything moves, because listing needs the
  // old paths.
  const plan = (projects: ReadonlyArray<Project>) =>
    Effect.forEach(
      projects,
      (project) =>
        Ops.listWorktreeIdentities({ projectId: project.id }).pipe(
          Effect.map((identities) =>
            identities.flatMap((i): Array<Entry & { oldId: string }> => {
              const under = underOld(i.path);
              if (i.isPrimary || under === undefined) return [];
              return [
                {
                  oldId: i.id,
                  projectId: project.id,
                  oldPath: i.path,
                  newPath: join(
                    newReal,
                    i.path.slice(under.length).replace(/^[/\\]/, ""),
                  ),
                  capture: null,
                  state: "planned",
                },
              ];
            }),
          ),
          // A project whose folder is gone has nothing to carry; one that is
          // there but can't be listed refuses the move, or its worktrees
          // would land with what they kept left under their old ids.
          Effect.catch(() =>
            Effect.flatMap(
              fs.exists(project.path).pipe(Effect.orElseSucceed(() => true)),
              (there) =>
                there
                  ? Effect.fail(
                      new DataDirMoveError({
                        reason: `Couldn't list the worktrees of "${project.name}", so what they keep couldn't follow them. Try again.`,
                      }),
                    )
                  : Effect.succeed([]),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((lists) => lists.flat()));

  const suffix = (yield* Random.nextInt).toString(36);
  // The pointer is written beside itself under a name of its own, then
  // renamed in.
  const pointerTmp = `${pointerFile}.tmp.${suffix}`;
  const journal: Omit<Types.Mutable<Journal>, "moved"> & {
    moved: Array<Entry>;
  } = {
    from: oldDir,
    to: newDir,
    partial: null,
    moved: [],
  };
  // Gone already is gone.
  const removeIfThere = (file: string) =>
    fs.remove(file, { force: true }).pipe(Effect.mapError(callFailureOf));
  const journalFile = join(oldDir, JOURNAL);
  const journalHere = Effect.suspend(() =>
    writeJournal(journalFile, journal).pipe(Effect.mapError(callFailureOf)),
  );
  let pointerStaged = false;
  let retired = false;
  let journaled = false;
  let renamed = false;
  const move = Effect.gen(function* () {
    // An earlier move's journal is the only record of what it still owes:
    // settled first, as a start settles it, and a move waits while it
    // can't be, rather than write its own over it.
    yield* resumeDataDirMove(oldDir).pipe(Effect.ignoreCause({ log: "Warn" }));
    const left = yield* fs
      .exists(journalFile)
      .pipe(Effect.orElseSucceed(() => true));
    if (left) {
      return yield* new DataDirMoveError({
        reason:
          "An earlier move of the data folder isn't finished or undone yet. " +
          "It's tried again at every start; see the log for what stops it.",
      });
    }
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
    // Same trap as nukeEverything: a project repo registered from inside
    // the data dir would be dragged along, breaking its recorded path.
    // Read holding the lock, so no project is added after.
    const projects = yield* freshProjects;
    const trapped = findProjectInsideDataDir(projects, spellings);
    if (trapped) {
      return yield* new DataDirMoveError({
        reason:
          `Refusing to move: project "${trapped.name}" lives inside ` +
          `${oldDir} and would be moved with it. Move the repository ` +
          "out first.",
      });
    }
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
    // Stage the pointer BEFORE moving anything: a move that succeeds
    // but leaves the pointer unwritable would strand the data where no
    // boot can find it. Staged last of the preconditions so a failure
    // above can't orphan the temp file. The default location needs no
    // pointer, so none is staged for it.
    if (!toDefault) {
      yield* fs
        .makeDirectory(dirname(pointerFile), { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFileString(pointerTmp, `${newDir}\n`)),
          Effect.andThen(flushed(pointerTmp)),
          Effect.mapError(callFailureOf),
        );
      pointerStaged = true;
    }

    // The store refusing every write but the move's, then the journal:
    // from here a start that finds the journal with the pointer unmoved
    // undoes the move, one that finds it at the new place finishes it.
    yield* retireStore.pipe(Effect.mapError(callFailureOf));
    retired = true;
    yield* journalHere;
    journaled = true;

    // The listing's own writes (an idle worktree shelved) are the move's.
    const entries = yield* asMoveOwner(plan(projects));
    // Nothing may be kept under an id a worktree is about to take: the
    // undo reads anything there as its own re-key's.
    for (const entry of entries) {
      const held = yield* keptUnderNewId(entry).pipe(
        Effect.orElseSucceed(() => true),
      );
      if (held) {
        return yield* new DataDirMoveError({
          reason: `Something is still kept for a worktree that was once at ${entry.newPath}, so ${entry.oldPath} can't take its place there. Move the data folder somewhere else.`,
        });
      }
    }
    yield* scripts.deleting(
      entries.map(({ oldId }) => oldId),
      "move",
    );
    // Each moved worktree with its dirty capture as it is now, read
    // strictly: the forward re-key carries that capture or fails, and an
    // undo carries back that one.
    const repoOf = new Map(projects.map(({ id, path }) => [id, path]));
    journal.moved = yield* Effect.forEach(entries, ({ oldId, ...entry }) =>
      git.readRef(repoOf.get(entry.projectId) ?? "", dirtyRef(oldId)).pipe(
        Effect.map(
          (capture): Entry => ({
            ...entry,
            capture: Option.getOrNull(capture),
          }),
        ),
      ),
    ).pipe(Effect.mapError(callFailureOf));
    yield* journalHere;

    // Re-key the marks and per-worktree data while the engine still
    // reads the old location (the pointer file moves below), each entry
    // marked as it is done. Undone below, or by the next start, if the
    // move never lands.
    for (const entry of journal.moved) {
      yield* rekeyForward(entry).pipe(Effect.mapError(callFailureOf));
      entry.state = "rekeyed";
      yield* journalHere;
    }

    yield* opts.beforeMove;

    // rename() can't cross volumes. Then the tree is copied into a
    // sibling of the destination, flushed whole, and renamed in. Either
    // way the folders the rename changed are flushed before the pointer
    // commits, so no power loss leaves a pointer naming a folder that
    // isn't on disk.
    // A rename and its mark are one step: one a cancel cut short after
    // the folder left would be undone where the data no longer is.
    const landed = Effect.sync(() => {
      renamed = true;
    });
    const sameVolume = yield* fs.rename(oldDir, newDir).pipe(
      Effect.andThen(landed),
      Effect.as(true),
      Effect.catchIf(crossesVolumes, () => Effect.succeed(false)),
      Effect.mapError(callFailureOf),
      Effect.uninterruptible,
    );
    if (!sameVolume) {
      journal.partial = `${newDir}.partial-${suffix}`;
      yield* journalHere;
      const partial = journal.partial;
      yield* opts.copy === undefined
        ? holdingStore(copyTree(oldDir, partial)).pipe(
            Effect.mapError(callFailureOf),
          )
        : opts.copy(oldDir, partial).pipe(Effect.mapError(callFailureOf));
      yield* flushTree(partial);
      yield* fs
        .rename(journal.partial, newDir)
        .pipe(
          Effect.andThen(landed),
          Effect.mapError(callFailureOf),
          Effect.uninterruptible,
        );
    }
    yield* flushed(dirname(newDir));
    if (sameVolume) yield* flushed(dirname(oldDir));

    // Point both readers (app boot, CLI) at the new location. Atomic
    // rename so no reader can ever see a half-written path, and flushed.
    // Committed before the old copy is deleted: if that cleanup fails
    // midway, the pointer already names the complete new copy. Moving to
    // the default removes the pointer instead, and the pre-2.0 pointer
    // goes either way: exactly one file may ever redirect a boot. A start
    // that found the folder gone may have committed it first (Paths'
    // rescue).
    yield* toDefault
      ? removeIfThere(pointerFile)
      : fs.rename(pointerTmp, pointerFile).pipe(
          Effect.catch((error) =>
            Effect.flatMap(
              fs
                .readFileString(pointerFile)
                .pipe(Effect.orElseSucceed(() => "")),
              (now) =>
                now.trim() === newDir ? Effect.void : Effect.fail(error),
            ),
          ),
          Effect.mapError(callFailureOf),
        );
    if (legacyPointerFile !== null) yield* removeIfThere(legacyPointerFile);
    yield* flushed(dirname(pointerFile));
    // The store this process holds is the old place's: the first one to
    // open it at the new place removes the old tree, the journal, and lets
    // it write.
    yield* finishMove(journal, newDir, {
      settle: false,
      file: join(newDir, JOURNAL),
    });
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        // A rename that failed may still have moved the folder (a network
        // volume's lost answer): the folder gone counts as landed.
        if (
          !renamed &&
          !(yield* fs.exists(oldDir).pipe(Effect.orElseSucceed(() => true)))
        ) {
          renamed = true;
        }
        // Once the folder landed, the staged pointer is how a start finds
        // it (Paths' rescue).
        if (pointerStaged && !renamed) {
          yield* Effect.ignore(removeIfThere(pointerTmp));
        }
        if (journaled && !renamed) {
          yield* undoMove(journal, oldDir, journalFile);
        } else if (retired && !journaled) {
          yield* Effect.ignore(reviveStore);
        }
      }),
    ),
    Effect.scoped,
  );
  const lock = yield* DataDirLock;
  yield* lock.alone(move, "30 seconds");
});

// The store held still while a copy reads it: a write transaction open
// for the copy's length (an UPDATE that changes nothing still takes the
// write lock), so a write from the terminal or a hook waits rather than
// tearing the copy, and the store left behind retired in the same
// transaction (`retireStore`).
export const holdingStore = <A, E, R>(copy: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE changes SET version = version WHERE 0`;
        const copied = yield* copy;
        yield* retireStore;
        return copied;
      }),
    ),
  );

// A rename refused because the two paths are on different volumes.
const crossesVolumes = (error: PlatformError.PlatformError) =>
  (error.reason.cause as { readonly code?: unknown } | undefined)?.code ===
  "EXDEV";
