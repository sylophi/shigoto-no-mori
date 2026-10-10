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
// ids are hashes of the worktree's absolute path, so everything the CLI
// keys by the id of every managed worktree under the data dir (marks,
// the per-worktree data file, a pending dirty capture) is re-keyed
// through `sm worktrees rekey`, and git's own worktree links are
// re-pointed by `git worktree repair`.
import { cp, mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Ops from "./engineOps";
import { run } from "./git/core";
import { findProjectInsideDataDir, freshProjects } from "./projects";
import {
  clearDeleteInflight,
  getBusyOperations,
  markDeleteInflight,
} from "./scripts";
import { tempPathFor, unlinkIfExists } from "./util/atomicJson";
import { fromPromise } from "./util/fromPromise";
import {
  canonicalDataDirName,
  dataDir,
  dataDirPointerPath,
  defaultDataDir,
  expandHome,
  isENOENT,
  legacyDataDirPointerPath,
} from "./util/paths";
// newId is filled in by the re-key, which the engine answers with.
type MovedWorktree = {
  oldId: string;
  oldPath: string;
  newPath: string;
  newId?: string;
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

export const moveDataDir = Effect.fnUntraced(function* <E, R>(
  // The new parent, or undefined to reset to the default location.
  parentDir: string | undefined,
  opts: {
    // The caller closes its fs watchers on the data dir here, before the
    // rename -- they're moot anyway, the app relaunches after the move.
    beforeMove: Effect.Effect<void, E, R>;
    // Every script's kill chain, waited for (host/lib/scripts).
    killAllScripts: Effect.Effect<void, never, R>;
  },
) {
  const oldDir = dataDir();
  // Resolved first: they throw when this session's data dir came from
  // an override, and nothing may be marked or reaped before that.
  const [pointerFile, legacyPointerFile] = yield* Effect.try({
    try: () => [dataDirPointerPath(), legacyDataDirPointerPath()] as const,
    catch: (error) =>
      new DataDirMoveError({
        reason: error instanceof Error ? error.message : String(error),
      }),
  });
  const parent =
    parentDir === undefined ? dirname(defaultDataDir()) : expandHome(parentDir);
  // Never resolve against the process cwd: a relative parent would land
  // the data dir somewhere the user never saw.
  if (!isAbsolute(parent)) {
    return yield* new DataDirMoveError({
      reason: `The new parent folder must be an absolute path: ${parentDir}`,
    });
  }
  const newDir = join(parent, canonicalDataDirName());
  const toDefault = newDir === defaultDataDir();

  if (isSameOrInside(newDir, oldDir)) {
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
  const trapped = findProjectInsideDataDir(projects);
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
  yield* fromPromise(async () => {
    await mkdir(parent, { recursive: true });
    // Clear an existing empty placeholder before the rename. A non-empty
    // directory is refused, never merged into.
    await rmdir(newDir).catch((err) => {
      if (!isENOENT(err)) {
        throw new Error(`${newDir} already exists and is not empty.`);
      }
    });
  });

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
          moved: identities
            .filter((i) => !i.isPrimary && isSameOrInside(i.path, oldDir))
            .map(
              (i): MovedWorktree => ({
                oldId: i.id,
                oldPath: i.path,
                newPath: join(
                  newDir,
                  i.path.slice(oldDir.length).replace(/^[/\\]/, ""),
                ),
              }),
            ),
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
  const pointerTmp = tempPathFor(pointerFile);
  let pointerStaged = false;
  let rekeyed = false;
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
      yield* fromPromise(async () => {
        await mkdir(dirname(pointerFile), { recursive: true });
        await writeFile(pointerTmp, `${newDir}\n`, "utf8");
      });
      pointerStaged = true;
    }

    // Re-key the marks and per-worktree data while the engine still
    // reads the old location (the pointer file moves below). Undone
    // below if the rename never happens.
    yield* rekeyWorktrees(repairTargets, false);
    rekeyed = true;

    yield* opts.beforeMove;

    // rename() can't cross volumes. Fall back to copy, commit the
    // pointer, then remove the old tree. Symlinks (carry-over entries)
    // are copied as links, not followed.
    const copied = yield* fromPromise(async () => {
      try {
        await rename(oldDir, newDir);
        return false;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      }
      try {
        await cp(oldDir, newDir, { recursive: true, verbatimSymlinks: true });
      } catch (cpErr) {
        // Don't strand a partial tree at the destination: it would make
        // every retry fail the empty-directory check above.
        await rm(newDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw cpErr;
      }
      return true;
    });
    renamed = true;

    yield* fromPromise(async () => {
      // Point both readers (app boot, CLI) at the new location. Atomic
      // rename so no reader can ever see a half-written path. Committed
      // before the old copy is deleted: if that cleanup fails midway,
      // the pointer already names the complete new copy. Leftovers beat
      // a boot against a half-deleted data dir. Moving to the default
      // removes the pointer instead, and the pre-2.0 pointer goes either
      // way: exactly one file may ever redirect a boot.
      if (toDefault) {
        await unlinkIfExists(pointerFile);
      } else {
        await rename(pointerTmp, pointerFile);
      }
      await unlinkIfExists(legacyPointerFile);
      if (copied) {
        await rm(oldDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    });

    // Re-link git's worktree metadata (each worktree's .git file and
    // the repo's .git/worktrees/<name>/gitdir both record absolute
    // paths). Repair is idempotent and re-runnable from the repo by
    // hand, so a failure here shouldn't undo an otherwise complete
    // move.
    yield* Effect.forEach(
      repairTargets.filter(({ moved }) => moved.length > 0),
      ({ project, moved }) =>
        Effect.ignore(
          run(project.path, [
            "worktree",
            "repair",
            ...moved.map((m) => m.newPath),
          ]),
        ),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        if (pointerStaged) {
          yield* Effect.promise(() =>
            unlinkIfExists(pointerTmp).catch(() => undefined),
          );
        }
        if (rekeyed && !renamed) {
          yield* Effect.ignore(rekeyWorktrees(repairTargets, true));
        }
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        for (const id of marked) clearDeleteInflight(id);
      }),
    ),
  );
});

// Carries what the engine keys by each moved worktree's id from its old
// id to the one its new path hashes to (or back, on `reverse`). The
// relocate flow's `sm worktrees move` does the same for one worktree.
// Each re-key is a locked read-modify-write of the same files, so they
// run one at a time.
const rekeyWorktrees = (
  targets: readonly { project: { id: string }; moved: MovedWorktree[] }[],
  reverse: boolean,
) =>
  Effect.forEach(
    targets.flatMap(({ project, moved }) =>
      moved.map((m) => ({ projectId: project.id, m })),
    ),
    ({ projectId, m }) => {
      if (!reverse) {
        return Ops.rekeyWorktree(projectId, m.oldId, m.newPath).pipe(
          Effect.tap((newId) =>
            Effect.sync(() => {
              m.newId = newId;
            }),
          ),
        );
      }
      return m.newId === undefined
        ? Effect.void
        : Ops.rekeyWorktree(projectId, m.newId, m.oldPath);
    },
    { discard: true },
  );
