// Moves the shigomori data dir to a new parent directory (or, with no
// parent, back to its default location): the folder relocates under the
// flavor's canonical name (.sm / .smd -- which is also how a pre-2.0
// ~/shigomori gets renamed), the pointer file (policy in
// shared/packaging/cliDist.mts) records the new spot for both the app's
// and the CLI's next boot -- or is removed when the new spot is the
// default, so "pointer exists" keeps meaning "relocated" -- and the
// caller must relaunch the app right after: the in-process data dir is
// a boot-time constant and every module has already derived paths from
// it.
//
// Two kinds of stored paths go stale and are carried along: worktree
// ids are hashes of the worktree's absolute path, so everything the
// engine keys by the id of every managed worktree under the data dir
// (marks, the worktree's data, a pending dirty capture) is re-keyed
// (the engine's rekey, `sm worktrees rekey`), and git's own worktree links are
// re-pointed by `git worktree repair`.
//
// A move a crash cuts short is finished or undone at the next start
// (resumeDataDirMove): the move keeps a journal in the data dir from
// before its re-key to its end, and a copy to another volume goes into a
// sibling of the destination, renamed in only once whole.
import { cp, mkdir, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import { callFailureOf, errorMessageOf } from "@shigomori/contracts/errors";
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
import * as Git from "@shigomori/engine/Git";
import { startOf } from "@shigomori/engine/processes";
import { findProjectInsideDataDir, freshProjects } from "./projects";
import {
  clearDeleteInflight,
  getBusyOperations,
  markDeleteInflight,
} from "./scripts";
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

const trimmed = (dir: string) => dir.replace(/\/+$/, "");

export const moveDataDir = Effect.fnUntraced(function* <E, R>(
  // The new parent, or undefined to reset to the default location.
  parentDir: string | undefined,
  opts: {
    readonly place: DataDirPlace;
    // The caller closes its fs watchers on the data dir here, before the
    // rename -- they're moot anyway, the app relaunches after the move.
    readonly beforeMove: Effect.Effect<void, E, R>;
    // Every script's kill chain, waited for (host/lib/scripts).
    readonly killAllScripts: Effect.Effect<void, never, R>;
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
  // Same trap as nukeEverything: a project repo registered from inside
  // the data dir would be dragged along, breaking its recorded path.
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
  // An earlier move's journal is the only record of what it still owes:
  // settled first, as a start settles it, and a move waits while it
  // can't be, rather than write its own over it.
  yield* resumeDataDirMove(oldDir).pipe(Effect.ignoreCause({ log: "Warn" }));
  if (
    yield* fs
      .exists(join(oldDir, JOURNAL))
      .pipe(Effect.orElseSucceed(() => true))
  ) {
    return yield* new DataDirMoveError({
      reason:
        "An earlier move of the data folder isn't finished or undone yet. " +
        "It's tried again at every start; see the log for what stops it.",
    });
  }
  // Running scripts are reaped below (same semantics as nuke), but
  // in-flight destructive lifecycle work (worktree/project deletes,
  // delegated engine runs) is mid-write inside the data dir and can't be
  // safely killed or moved under. Refuse instead.
  if (getBusyOperations().inflightDeletes > 0) {
    return yield* new DataDirMoveError({
      reason:
        "Another operation is still running (worktree delete or CLI " +
        "command). Try again when it finishes.",
    });
  }
  yield* fsStep(async () => {
    await mkdir(parent, { recursive: true });
    // Clear an existing empty placeholder before the rename. A non-empty
    // directory is refused, never merged into.
    await rmdir(newDir).catch((err: NodeJS.ErrnoException) => {
      if (isENOENT(err)) return;
      if (err.code === "ENOTEMPTY" || err.code === "EEXIST") {
        throw new Error(`${newDir} already exists and is not empty.`);
      }
      throw err;
    });
  });

  // Where git will name the moved worktrees: by the destination's real
  // spelling, which their new ids hash.
  const newReal = join(
    yield* fs.realPath(parent).pipe(Effect.orElseSucceed(() => parent)),
    place.dataDirName,
  );

  // Managed worktrees whose checkout sits under the data dir, as git
  // lists them once the store refuses every other process's writes (a
  // create, an adopt or a move in the terminal can't change them after):
  // their ids are marked delete-inflight for the rest of the move
  // (blocking a renderer script run from landing in a directory
  // mid-move, exactly like the nuke flow), what they keep re-keyed, and
  // their git links repaired afterwards. Listed before anything moves,
  // because listing needs the old paths.
  const plan = Effect.forEach(
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
    pid: process.pid,
    ...Option.match(yield* startOf(process.pid), {
      onNone: () => ({}),
      onSome: (startedAt) => ({ startedAt }),
    }),
    moved: [],
  };
  // Gone already is gone.
  const removeIfThere = (file: string) =>
    fs.remove(file, { force: true }).pipe(Effect.mapError(callFailureOf));
  const journalHere = Effect.suspend(() =>
    writeJournal(oldDir, journal).pipe(Effect.mapError(callFailureOf)),
  );
  const marked: Array<string> = [];
  let pointerStaged = false;
  let journaled = false;
  let renamed = false;
  yield* Effect.gen(function* () {
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
          Effect.mapError(callFailureOf),
        );
      pointerStaged = true;
    }

    // The journal, then the store refusing every write but the move's:
    // from here a start that finds the journal with the pointer unmoved
    // undoes the move, one that finds it at the new place finishes it.
    yield* journalHere;
    journaled = true;
    yield* retireStore.pipe(Effect.mapError(callFailureOf));

    // The listing's own writes (an idle worktree shelved) are the move's.
    const entries = yield* asMoveOwner(plan);
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
    for (const { oldId } of entries) {
      markDeleteInflight(oldId);
      marked.push(oldId);
    }
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
    // sibling of the destination, renamed in once whole, the pointer
    // committed, and the old tree removed.
    const sameVolume = yield* fs.rename(oldDir, newDir).pipe(
      Effect.as(true),
      Effect.catchIf(crossesVolumes, () => Effect.succeed(false)),
      Effect.mapError(callFailureOf),
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
      yield* fs
        .rename(journal.partial, newDir)
        .pipe(Effect.mapError(callFailureOf));
    }
    renamed = true;

    // Point both readers (app boot, CLI) at the new location. Atomic
    // rename so no reader can ever see a half-written path. Committed
    // before the old copy is deleted: if that cleanup fails midway, the
    // pointer already names the complete new copy. Leftovers beat a boot
    // against a half-deleted data dir. Moving to the default removes the
    // pointer instead, and the pre-2.0 pointer goes either way: exactly
    // one file may ever redirect a boot.
    yield* toDefault
      ? removeIfThere(pointerFile)
      : fs.rename(pointerTmp, pointerFile).pipe(Effect.mapError(callFailureOf));
    if (legacyPointerFile !== null) yield* removeIfThere(legacyPointerFile);
    // The store this process holds is the old place's: the first one to
    // open it at the new place lets it write and removes the journal.
    yield* finishMove(journal, newDir, { revive: false });
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        // Once the folder landed, the staged pointer is how a start finds
        // it (Paths' rescue).
        if (pointerStaged && !renamed) {
          yield* Effect.ignore(removeIfThere(pointerTmp));
        }
        if (journaled && !renamed) yield* undoMove(journal, oldDir);
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        for (const id of marked) clearDeleteInflight(id);
      }),
    ),
  );
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
