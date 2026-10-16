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
import { cp, mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import { callFailureOf, errorMessageOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Types from "effect/Types";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import * as Ops from "./engineOps";
import * as Git from "@shigomori/engine/Git";
import { startOf } from "@shigomori/engine/processes";
import { findProjectInsideDataDir, freshProjects } from "./projects";
import {
  clearDeleteInflight,
  getBusyOperations,
  markDeleteInflight,
} from "./scripts";
import {
  JOURNAL,
  type Journal,
  JournalJson,
  retireStore,
  reviveStore,
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
type MovedWorktree = {
  oldId: string;
  oldPath: string;
  newPath: string;
};

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
  // git spells a path under a data folder reached through a link (/tmp,
  // /var/folders, a folder linked to another drive) by the link's
  // target, so a path counts as under it by either spelling.
  const oldReal = yield* fs
    .realPath(oldDir)
    .pipe(Effect.orElseSucceed(() => oldDir));
  // A rename would move the link and leave its target where it is.
  const link = yield* fs.readLink(oldDir).pipe(Effect.option);
  if (Option.isSome(link)) {
    return yield* new DataDirMoveError({
      reason: `The data folder is a link to ${oldReal}. Move that folder instead.`,
    });
  }
  const spellings = [oldDir, oldReal].map((dir) => dir.replace(/\/+$/, ""));
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

  // Managed worktrees whose checkout sits under the data dir: their ids get
  // marked delete-inflight for the whole move (blocking a renderer
  // script run from landing in a directory mid-move, exactly like the
  // nuke flow), their shigomori state re-keyed, and their git metadata
  // repaired afterwards. Collected before anything moves, because
  // listing needs the old paths.
  const repairTargets = yield* Effect.forEach(
    projects,
    (project) =>
      Ops.listWorktreeIdentities({ projectId: project.id }).pipe(
        Effect.map((identities) => ({
          project,
          moved: identities.flatMap((i): MovedWorktree[] => {
            const under = underOld(i.path);
            if (i.isPrimary || under === undefined) return [];
            return [
              {
                oldId: i.id,
                oldPath: i.path,
                newPath: join(
                  newReal,
                  i.path.slice(under.length).replace(/^[/\\]/, ""),
                ),
              },
            ];
          }),
        })),
        // Repo moved or deleted, so nothing to repair for this one.
        Effect.orElseSucceed(() => ({
          project,
          moved: [] as MovedWorktree[],
        })),
      ),
    { concurrency: "unbounded" },
  );

  const marked = repairTargets.flatMap(({ moved }) =>
    moved.map((m) => m.oldId),
  );
  for (const id of marked) markDeleteInflight(id);
  const suffix = (yield* Random.nextInt).toString(36);
  // The pointer is written beside itself under a name of its own, then
  // renamed in.
  const pointerTmp = `${pointerFile}.tmp.${suffix}`;
  const journalFile = join(oldDir, JOURNAL);
  const journal: Types.Mutable<Journal> = {
    from: oldDir,
    to: newDir,
    partial: null,
    pid: process.pid,
    ...Option.match(yield* startOf(process.pid), {
      onNone: () => ({}),
      onSome: (startedAt) => ({ startedAt }),
    }),
    moved: repairTargets.flatMap(({ project, moved }) =>
      moved.map((m) => ({
        projectId: project.id,
        oldPath: m.oldPath,
        newPath: m.newPath,
      })),
    ),
  };
  // Gone already is gone.
  const removeIfThere = (file: string) =>
    fs.remove(file, { force: true }).pipe(Effect.mapError(callFailureOf));
  const writeJournal = Effect.suspend(() =>
    writeWhole(fs, journalFile, Schema.encodeSync(JournalJson)(journal)),
  );
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

    // The journal before the re-key: from here, a start that finds it
    // with the pointer unmoved undoes the re-key, and one that finds it
    // at the new place finishes the move.
    yield* writeJournal;
    journaled = true;

    // Re-key the marks and per-worktree data while the engine still
    // reads the old location (the pointer file moves below). Undone
    // below, or by the next start, if the move never lands.
    yield* rekeyWorktrees(journal.moved, false);

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
      yield* writeJournal;
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
    yield* finishMove(journal, newDir);
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

// `text` at `file`, written beside it and renamed in.
const writeWhole = (fs: FileSystem.FileSystem, file: string, text: string) =>
  Effect.gen(function* () {
    const staged = `${file}.tmp`;
    yield* fs.writeFileString(staged, text);
    yield* fs.rename(staged, file);
  }).pipe(Effect.mapError(callFailureOf));

// The end of a move that landed at `at`: the old tree a copy left goes,
// git's worktree links are re-pointed (each worktree's .git file and the
// repo's .git/worktrees/<name>/gitdir record absolute paths), and the
// journal goes last. Each step is idempotent, so a start that finds the
// journal runs it again; none of them can undo a complete move.
const finishMove = (journal: Journal, at: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (journal.partial !== null && resolve(journal.from) !== resolve(at)) {
      yield* fsStep(() =>
        rm(journal.from, { recursive: true, force: true }).catch(
          () => undefined,
        ),
      );
    }
    const byProject = new Map<string, string[]>();
    for (const m of journal.moved) {
      byProject.set(m.projectId, [
        ...(byProject.get(m.projectId) ?? []),
        m.newPath,
      ]);
    }
    const projects = yield* Effect.orElseSucceed(freshProjects, () => []);
    const git = yield* Git.Git;
    yield* Effect.forEach(
      byProject,
      ([projectId, paths]) => {
        const project = projects.find((one) => one.id === projectId);
        return project === undefined
          ? Effect.void
          : Effect.ignore(
              git.run(project.path, ["worktree", "repair", ...paths]),
            );
      },
      { concurrency: "unbounded", discard: true },
    );
    yield* Effect.ignore(fs.remove(join(at, JOURNAL), { force: true }));
  });

// A move that never landed, undone where the data still is (`at`): the
// re-key reversed (a worktree never re-keyed has nothing under its new
// id, which the re-key passes over), the partial copy removed, the
// journal last.
const undoMove = (journal: Journal, at: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // A store that can't write again keeps the journal, for its next
    // open to revive it.
    const revived = yield* reviveStore.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    yield* Effect.ignore(rekeyWorktrees(journal.moved, true));
    if (journal.partial !== null) {
      yield* Effect.ignore(
        fs.remove(journal.partial, { recursive: true, force: true }),
      );
      // A copy renamed in before the pointer moved: this move's own, as
      // the journal it carries says, and never the data the pointer
      // names.
      const landed = yield* fs.readFileString(join(journal.to, JOURNAL)).pipe(
        Effect.map(Schema.decodeUnknownOption(JournalJson)),
        Effect.orElseSucceed(() => Option.none<Journal>()),
      );
      if (
        Option.isSome(landed) &&
        landed.value.from === journal.from &&
        landed.value.partial === journal.partial &&
        resolve(journal.to) !== resolve(at)
      ) {
        yield* Effect.ignore(
          fs.remove(journal.to, { recursive: true, force: true }),
        );
      }
    }
    if (revived) {
      yield* Effect.ignore(fs.remove(join(at, JOURNAL), { force: true }));
    }
  });

// At start, with the graph up and before anything reads a worktree by
// its id: a journal in this session's data dir is a move a crash cut
// short. At its destination it is finished; at its source, where the
// pointer still leads, it is undone.
const resumeDataDirMove = (at: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(join(at, JOURNAL))
      .pipe(Effect.option);
    if (Option.isNone(text)) return;
    const journal = Schema.decodeUnknownOption(JournalJson)(text.value);
    if (Option.isNone(journal)) {
      yield* Effect.logWarning("[data] an unreadable move journal, removed");
      return yield* Effect.ignore(fs.remove(join(at, JOURNAL)));
    }
    // The pointer may name the folder with a trailing slash.
    if (resolve(journal.value.to) === resolve(at)) {
      yield* Effect.logInfo(
        `[data] finishing the move from ${journal.value.from}`,
      );
      return yield* finishMove(journal.value, at);
    }
    yield* Effect.logInfo(`[data] undoing the move to ${journal.value.to}`);
    yield* undoMove(journal.value, at);
  });

// Carries what the engine keys by each moved worktree's id from its old
// id to the one its new path hashes to (or back, on `reverse`). The
// relocate flow's `sm worktrees move` does the same for one worktree.
// Each re-key is a read-modify-write of the same rows, so they run
// one at a time.
const rekeyWorktrees = (moved: Journal["moved"], reverse: boolean) =>
  Effect.forEach(
    moved,
    (m) =>
      reverse
        ? Ops.rekeyWorktree(
            m.projectId,
            worktreeIdFromPath(m.newPath),
            m.oldPath,
          )
        : Ops.rekeyWorktree(
            m.projectId,
            worktreeIdFromPath(m.oldPath),
            m.newPath,
          ),
    { discard: true },
  );

// The resume as the host's graph runs it at start (process/layer.ts),
// on this session's data dir. A failure is a log line: the move's
// leftovers never keep the app from starting.
export const resumeLayer = Layer.effectDiscard(
  Effect.suspend(() => resumeDataDirMove(dataDir())).pipe(
    Effect.ignoreCause({
      log: "Warn",
      message: "[data] the unfinished move failed",
    }),
  ),
);
