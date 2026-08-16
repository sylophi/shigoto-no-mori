// Moves the shigomori state root to a new parent directory: the folder
// itself (basename unchanged) relocates, the pointer file (policy in
// shared/cliDist.mts) records the new spot for both the app's and the
// CLI's next boot, and the caller must relaunch the app right after --
// the in-process root is a boot-time constant and every module has
// already derived paths from it.
//
// No per-file state rewriting is needed: nothing under the root stores
// absolute paths into the root (worktree paths are derived from
// shigomoriRoot() at runtime). The only absolute paths that go stale
// are git's own worktree links, which `git worktree repair` fixes.
import { cp, mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { run } from "./git/core";
import { listWorktreeIdentities } from "./git/worktrees";
import { findProjectInsideRoot, loadProjects } from "./projects";
import {
  clearDeleteInflight,
  getBusyOperations,
  killAllScripts,
  markDeleteInflight,
} from "./scripts";
import { tempPathFor, unlinkIfExists } from "./util/jsonFile";
import {
  comparablePath,
  isSameOrInside,
  rootPointerPath,
  shigomoriRoot,
  toAbsolute,
} from "./util/paths";

export async function moveShigomoriRoot(
  parentDir: string,
  // Electron-side pre-rename hook: the caller closes its fs watchers on
  // the root here. Windows watch handles can block the rename, and the
  // watchers are moot anyway -- the app relaunches after the move.
  opts: { beforeMove?: () => void } = {},
): Promise<void> {
  const oldRoot = shigomoriRoot();
  const parent = toAbsolute(parentDir);
  const newRoot = join(parent, basename(oldRoot));

  if (isSameOrInside(newRoot, oldRoot)) {
    throw new Error(
      comparablePath(newRoot) === comparablePath(oldRoot)
        ? `The data folder is already at ${oldRoot}.`
        : `Can't move the data folder inside itself (${oldRoot}).`,
    );
  }
  // Same trap as nukeEverything: a project repo registered from inside
  // the root would be dragged along, breaking its recorded path.
  const projects = loadProjects();
  const trapped = findProjectInsideRoot(projects);
  if (trapped) {
    throw new Error(
      `Refusing to move: project "${trapped.name}" lives inside ` +
        `${oldRoot} and would be moved with it. Move the repository ` +
        "out first.",
    );
  }
  // Running scripts are reaped below (same semantics as nuke), but
  // in-flight destructive lifecycle work -- worktree/project deletes,
  // delegated CLI children -- is mid-write inside the root and can't be
  // safely killed or moved under. Refuse instead.
  if (getBusyOperations().inflightDeletes > 0) {
    throw new Error(
      "Another operation is still running (worktree delete or CLI " +
        "command). Try again when it finishes.",
    );
  }
  await mkdir(parent, { recursive: true });
  // rename() onto an existing empty directory is fine on POSIX but not
  // on Windows. Clearing the placeholder first behaves the same
  // everywhere. A non-empty directory is refused, never merged into.
  await rmdir(newRoot).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`${newRoot} already exists and is not empty.`);
    }
  });

  // Managed worktrees whose checkout sits under the root: their ids get
  // marked delete-inflight for the whole move (blocking a renderer
  // script run from landing in a directory mid-move, exactly like the
  // nuke flow), and their git metadata gets repaired afterwards.
  // Collected before anything moves -- listing needs the old paths.
  const repairTargets = await Promise.all(
    projects.map(async (project) => {
      try {
        const identities = await listWorktreeIdentities(
          project.id,
          project.path,
        );
        const moved = identities.filter(
          (i) => !i.isPrimary && isSameOrInside(i.path, oldRoot),
        );
        return {
          project,
          ids: moved.map((i) => i.id),
          newPaths: moved.map((i) =>
            join(newRoot, i.path.slice(oldRoot.length).replace(/^[/\\]/, "")),
          ),
        };
      } catch {
        // Repo moved or deleted, so nothing to repair for this one.
        return { project, ids: [], newPaths: [] };
      }
    }),
  );

  const marked = repairTargets.flatMap(({ ids }) => ids);
  for (const id of marked) markDeleteInflight(id);
  const pointerFile = rootPointerPath();
  const pointerTmp = tempPathFor(pointerFile);
  let pointerStaged = false;
  try {
    // Scripts running inside the worktrees we're about to move would
    // keep cwds pointing at the old location. Reap them first.
    await killAllScripts();
    // Stage the pointer BEFORE moving anything: a move that succeeds
    // but leaves the pointer unwritable would strand the data where no
    // boot can find it. Staged last of the preconditions so a failure
    // above can't orphan the temp file.
    await mkdir(dirname(pointerFile), { recursive: true });
    await writeFile(pointerTmp, `${newRoot}\n`, "utf8");
    pointerStaged = true;

    opts.beforeMove?.();

    // rename() can't cross volumes. Fall back to copy, commit the
    // pointer, then remove the old tree. Symlinks (carry-over entries)
    // are copied as links, not followed.
    let copied = false;
    try {
      await rename(oldRoot, newRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      try {
        await cp(oldRoot, newRoot, { recursive: true, verbatimSymlinks: true });
      } catch (cpErr) {
        // Don't strand a partial tree at the destination: it would make
        // every retry fail the empty-directory check above.
        await rm(newRoot, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw cpErr;
      }
      copied = true;
    }

    // Point both readers (app boot, CLI) at the new location. Atomic
    // rename so no reader can ever see a half-written path. Committed
    // before the old copy is deleted: if that cleanup fails midway, the
    // pointer already names the complete new copy -- leftovers beat a
    // boot against a half-deleted root.
    await rename(pointerTmp, pointerFile);
    if (copied) {
      await rm(oldRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }

    // Re-link git's worktree metadata (each worktree's .git file and
    // the repo's .git/worktrees/<name>/gitdir both record absolute
    // paths). Repair is idempotent and re-runnable from the repo by
    // hand, so a failure here shouldn't undo an otherwise complete
    // move.
    await Promise.all(
      repairTargets
        .filter(({ newPaths }) => newPaths.length > 0)
        .map(({ project, newPaths }) =>
          run(project.path, ["worktree", "repair", ...newPaths]).catch(
            () => undefined,
          ),
        ),
    );
  } catch (err) {
    if (pointerStaged) await unlinkIfExists(pointerTmp).catch(() => undefined);
    throw err;
  } finally {
    for (const id of marked) clearDeleteInflight(id);
  }
}
