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
// A journal entry, its mark set as the move goes.
type Entry = Types.Mutable<Journal["moved"][number]>;

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
  yield* resumeDataDirMove(oldDir);
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
                : Effect.succeed({ project, moved: [] as MovedWorktree[] }),
          ),
        ),
      ),
    { concurrency: "unbounded" },
  );

  // Nothing may be kept under an id a worktree is about to take: the
  // undo reads anything there as its own re-key's (V3.md, Commit points).
  for (const { project, moved } of repairTargets) {
    for (const m of moved) {
      const held = yield* Ops.keptUnder(
        project.id,
        worktreeIdFromPath(m.newPath),
      ).pipe(Effect.orElseSucceed(() => true));
      if (held) {
        return yield* new DataDirMoveError({
          reason: `Something is still kept for a worktree that was once at ${m.newPath}, so ${m.oldPath} can't take its place there. Move the data folder somewhere else.`,
        });
      }
    }
  }

  const marked = repairTargets.flatMap(({ moved }) =>
    moved.map((m) => m.oldId),
  );
  for (const id of marked) markDeleteInflight(id);
  const suffix = (yield* Random.nextInt).toString(36);
  // The pointer is written beside itself under a name of its own, then
  // renamed in.
  const pointerTmp = `${pointerFile}.tmp.${suffix}`;
  const journalFile = join(oldDir, JOURNAL);
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
  // Each moved worktree with its dirty capture as it is now, read with
  // the scripts gone and just before the journal: the forward re-key
  // carries that capture or fails, and an undo carries back that one.
  const snapshot = Effect.forEach(
    repairTargets.flatMap(({ project, moved }) =>
      moved.map((m) => ({ project, m })),
    ),
    ({ project, m }) =>
      git.readRef(project.path, dirtyRef(m.oldId)).pipe(
        Effect.map(
          (capture): Entry => ({
            projectId: project.id,
            oldPath: m.oldPath,
            newPath: m.newPath,
            capture: Option.getOrNull(capture),
            state: "planned",
          }),
        ),
        Effect.mapError(callFailureOf),
      ),
  );
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
    journal.moved = yield* snapshot;
    yield* writeJournal;
    journaled = true;

    // Re-key the marks and per-worktree data while the engine still
    // reads the old location (the pointer file moves below), each entry
    // marked as it is done. Undone below, or by the next start, if the
    // move never lands.
    for (const entry of journal.moved) {
      yield* rekeyForward(entry);
      entry.state = "rekeyed";
      yield* writeJournal;
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
    // The old tree's journal goes with its folder, last, so a removal cut
    // short still reads as this move's at the next start, which removes
    // the rest; until then the journal here is kept too, as it is while
    // the old tree's can't be read.
    const owner =
      journal.partial === null || resolve(journal.from) === resolve(at)
        ? ("not" as const)
        : yield* ownJournalAt(journal.from, journal);
    if (owner === "unknown") {
      yield* Effect.logWarning(
        `[data] finishing a data-folder move, whether ${journal.from} is its old copy can't be read; the journal is kept for the next start`,
      );
    }
    const cleaned =
      owner === "not" ||
      (owner === "ours" &&
        (yield* fs.readDirectory(journal.from).pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter((entry) => entry !== JOURNAL),
              (entry) =>
                fs.remove(join(journal.from, entry), {
                  recursive: true,
                  force: true,
                }),
              { discard: true },
            ),
          ),
          Effect.andThen(
            fs.remove(journal.from, { recursive: true, force: true }),
          ),
          (removal) => settled(removal, "removing the old copy", "finishing"),
        )));
    const byProject = new Map<string, string[]>();
    for (const m of journal.moved) {
      byProject.set(m.projectId, [
        ...(byProject.get(m.projectId) ?? []),
        m.newPath,
      ]);
    }
    const git = yield* Git.Git;
    // A repair that failed (a repo unreadable for now) keeps the journal,
    // so the next start repairs again; a project gone since has nothing
    // to repair.
    const repaired = yield* freshProjects.pipe(
      Effect.flatMap((projects) =>
        Effect.forEach(
          byProject,
          ([projectId, paths]) => {
            const project = projects.find((one) => one.id === projectId);
            return project === undefined
              ? Effect.void
              : Effect.asVoid(
                  git.run(project.path, ["worktree", "repair", ...paths]),
                );
          },
          { concurrency: "unbounded", discard: true },
        ),
      ),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning(
            "[data] a moved worktree's link wasn't repaired; the move's journal is kept for the next start",
            cause,
          ),
          false,
        ),
      ),
    );
    if (cleaned && repaired) {
      yield* Effect.ignore(fs.remove(join(at, JOURNAL), { force: true }));
    }
  });

// Whether the folder at `dir` is this move's copy, by the journal it
// carries: a folder made there since, or one a removal already took,
// holds none; one that can't be read can't be told.
const ownJournalAt = (dir: string, journal: Journal) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(join(dir, JOURNAL)).pipe(
      Effect.map((text) => {
        const found = Schema.decodeUnknownOption(JournalJson)(text);
        return Option.isSome(found) &&
          found.value.from === journal.from &&
          found.value.partial === journal.partial
          ? ("ours" as const)
          : ("not" as const);
      }),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed("not" as const),
      ),
      Effect.orElseSucceed(() => "unknown" as const),
    ),
  );

// A step of a finish or an undo that failed keeps the journal, for the
// next start to carry on.
const settled = <A, E, R>(
  step: Effect.Effect<A, E, R>,
  what: string,
  doing: "undoing" | "finishing" = "undoing",
) =>
  step.pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning(
          `[data] ${doing} a data-folder move, ${what} failed; the journal is kept for the next start`,
          cause,
        ),
        false,
      ),
    ),
  );

// A move that never landed, undone where the data still is (`at`), by
// the journal's marks (V3.md, Commit points): each entry re-keyed back,
// last first, and marked before the next; the partial copy removed; the
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
    const entries: Array<Entry> = journal.moved.map((entry) => ({
      ...entry,
    }));
    let rekeyed = true;
    for (const entry of entries.toReversed()) {
      const state = entry.state ?? "planned";
      if (state === "returned") continue;
      const back = Effect.gen(function* () {
        // A `planned` entry's re-key may have run before a crash took
        // its mark: anything under its new id is its re-key's, since a
        // move starts only with nothing there.
        if (
          state === "planned" &&
          !(yield* Ops.keptUnder(
            entry.projectId,
            worktreeIdFromPath(entry.newPath),
          ))
        ) {
          return;
        }
        yield* rekeyBack(entry);
      });
      const done = yield* settled(
        back.pipe(
          Effect.andThen(
            Effect.suspend(() => {
              entry.state = "returned";
              return Effect.suspend(() =>
                writeWhole(
                  fs,
                  join(at, JOURNAL),
                  Schema.encodeSync(JournalJson)({
                    ...journal,
                    moved: entries,
                  }),
                ),
              );
            }),
          ),
        ),
        "the re-key back",
      );
      rekeyed = rekeyed && done;
    }
    let removed = true;
    if (journal.partial !== null) {
      removed = yield* settled(
        fs.remove(journal.partial, { recursive: true, force: true }),
        "removing the partial copy",
      );
      // A copy renamed in before the pointer moved: this move's own, as
      // the journal it carries says, and never the data the pointer
      // names.
      const landed =
        resolve(journal.to) === resolve(at)
          ? ("not" as const)
          : yield* ownJournalAt(journal.to, journal);
      if (landed === "ours") {
        removed =
          (yield* settled(
            fs.remove(journal.to, { recursive: true, force: true }),
            "removing the landed copy",
          )) && removed;
      } else if (landed === "unknown") {
        yield* Effect.logWarning(
          `[data] undoing a data-folder move, whether ${journal.to} is its copy can't be read; the journal is kept for the next start`,
        );
        removed = false;
      }
    }
    if (revived && rekeyed && removed) {
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
    // None only when there is none: one that can't be read is kept, and
    // keeps a move from starting over it.
    const text = yield* fs.readFileString(join(at, JOURNAL)).pipe(
      Effect.map(Option.some),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed(Option.none<string>()),
      ),
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(
            `[data] a move journal at ${join(at, JOURNAL)} can't be read, kept for a look`,
            error,
          ),
          Option.none<string>(),
        ),
      ),
    );
    if (Option.isNone(text)) return;
    const journal = Schema.decodeUnknownOption(JournalJson)(text.value);
    // Kept: it may be the only record of what a move left half done.
    if (Option.isNone(journal)) {
      return yield* Effect.logWarning(
        `[data] an unreadable move journal at ${join(at, JOURNAL)}, kept for a look`,
      );
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

// Carries what the engine keys by a moved worktree's id from its old id
// to the one its new path hashes to, or back. The relocate flow's `sm
// worktrees move` does the same for one worktree. The capture follows
// only if it is the one the journal names: forward, another fails the
// move (`changed`); back, another stays where it is.
const rekeyForward = (entry: Entry) =>
  Ops.rekeyWorktree(
    entry.projectId,
    worktreeIdFromPath(entry.oldPath),
    entry.newPath,
    { expect: entry.capture ?? null },
  );

const rekeyBack = (entry: Entry) =>
  Ops.rekeyWorktree(
    entry.projectId,
    worktreeIdFromPath(entry.newPath),
    entry.oldPath,
    { expect: entry.capture ?? null, back: true },
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
