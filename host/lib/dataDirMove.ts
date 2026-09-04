// Moves the shigomori data dir to a new parent directory (or, with no
// parent, renames it where it stands): the folder relocates under the
// flavor's canonical name (.sm / .smd -- which is also how a pre-2.0
// ~/shigomori gets renamed), the pointer file (policy in
// shared/cliDist.mts) records the new spot for both the app's and the
// CLI's next boot -- or is removed when the new spot is the default,
// so "pointer exists" keeps meaning "relocated" -- and the caller must
// relaunch the app right after: the in-process data dir is a boot-time
// constant and every module has already derived paths from it.
//
// Two kinds of stored paths go stale and are carried along: worktree
// ids are hashes of the worktree's absolute path (git/worktrees.ts
// worktreeIdFromPath), so the shelf flag and per-worktree data file of
// every managed worktree under the data dir are re-keyed, and git's
// own worktree links are re-pointed by `git worktree repair`.
import { cp, mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSameOrInside } from "@shared/worktreeLayout";
import {
  deleteWorktreeData,
  readWorktreeData,
  writeWorktreeData,
} from "./config/project";
import { run } from "./git/core";
import { listWorktreeIdentities, worktreeIdFromPath } from "./git/worktrees";
import { findProjectInsideDataDir, loadProjects } from "./projects";
import {
  clearDeleteInflight,
  getBusyOperations,
  killAllScripts,
  markDeleteInflight,
} from "./scripts";
import { tempPathFor, unlinkIfExists } from "./util/jsonFile";
import {
  canonicalDataDirName,
  dataDir,
  dataDirPointerPath,
  defaultDataDir,
  isENOENT,
  legacyDataDirPointerPath,
  toAbsolute,
} from "./util/paths";
import { dropShelved, isShelved, setShelved } from "./worktrees/shelved";

type MovedWorktree = { oldId: string; newId: string; newPath: string };

export async function moveDataDir(
  // The new parent, or undefined to rename in place.
  parentDir: string | undefined,
  // Electron-side pre-rename hook: the caller closes its fs watchers on
  // the data dir here -- they're moot anyway, the app relaunches after
  // the move.
  opts: { beforeMove?: () => void } = {},
): Promise<void> {
  const oldDir = dataDir();
  // Resolved first: they throw when this session's data dir came from
  // an override, and nothing may be marked or reaped before that.
  const pointerFile = dataDirPointerPath();
  const legacyPointerFile = legacyDataDirPointerPath();
  const parent =
    parentDir === undefined ? dirname(oldDir) : toAbsolute(parentDir);
  const newDir = join(parent, canonicalDataDirName());
  const toDefault = newDir === defaultDataDir();

  if (isSameOrInside(newDir, oldDir)) {
    throw new Error(
      newDir === oldDir
        ? `The data folder is already at ${oldDir}.`
        : `Can't move the data folder inside itself (${oldDir}).`,
    );
  }
  // Same trap as nukeEverything: a project repo registered from inside
  // the data dir would be dragged along, breaking its recorded path.
  const projects = loadProjects();
  const trapped = findProjectInsideDataDir(projects);
  if (trapped) {
    throw new Error(
      `Refusing to move: project "${trapped.name}" lives inside ` +
        `${oldDir} and would be moved with it. Move the repository ` +
        "out first.",
    );
  }
  // Running scripts are reaped below (same semantics as nuke), but
  // in-flight destructive lifecycle work -- worktree/project deletes,
  // delegated CLI children -- is mid-write inside the data dir and can't be
  // safely killed or moved under. Refuse instead.
  if (getBusyOperations().inflightDeletes > 0) {
    throw new Error(
      "Another operation is still running (worktree delete or CLI " +
        "command). Try again when it finishes.",
    );
  }
  await mkdir(parent, { recursive: true });
  // Clear an existing empty placeholder before the rename. A non-empty
  // directory is refused, never merged into.
  await rmdir(newDir).catch((err) => {
    if (!isENOENT(err)) {
      throw new Error(`${newDir} already exists and is not empty.`);
    }
  });

  // Managed worktrees whose checkout sits under the data dir: their ids get
  // marked delete-inflight for the whole move (blocking a renderer
  // script run from landing in a directory mid-move, exactly like the
  // nuke flow), their shigomori state re-keyed, and their git metadata
  // repaired afterwards. Collected before anything moves -- listing
  // needs the old paths.
  const repairTargets = await Promise.all(
    projects.map(async (project) => {
      try {
        const identities = await listWorktreeIdentities(
          project.id,
          project.path,
        );
        const moved: MovedWorktree[] = identities
          .filter((i) => !i.isPrimary && isSameOrInside(i.path, oldDir))
          .map((i) => {
            const newPath = join(
              newDir,
              i.path.slice(oldDir.length).replace(/^[/\\]/, ""),
            );
            return { oldId: i.id, newId: worktreeIdFromPath(newPath), newPath };
          });
        return { project, moved };
      } catch {
        // Repo moved or deleted, so nothing to repair for this one.
        return { project, moved: [] as MovedWorktree[] };
      }
    }),
  );

  const marked = repairTargets.flatMap(({ moved }) =>
    moved.map((m) => m.oldId),
  );
  for (const id of marked) markDeleteInflight(id);
  const pointerTmp = tempPathFor(pointerFile);
  let pointerStaged = false;
  let rekeyed = false;
  let renamed = false;
  try {
    // Scripts running inside the worktrees we're about to move would
    // keep cwds pointing at the old location. Reap them first.
    await killAllScripts();
    // Stage the pointer BEFORE moving anything: a move that succeeds
    // but leaves the pointer unwritable would strand the data where no
    // boot can find it. Staged last of the preconditions so a failure
    // above can't orphan the temp file. The default location needs no
    // pointer, so none is staged for it.
    if (!toDefault) {
      await mkdir(dirname(pointerFile), { recursive: true });
      await writeFile(pointerTmp, `${newDir}\n`, "utf8");
      pointerStaged = true;
    }

    // Re-key the shelf and per-worktree data while the stores still
    // point at the old location (they derive paths from dataDir()).
    // Undone below if the rename never happens.
    await rekeyWorktrees(repairTargets, false);
    rekeyed = true;

    opts.beforeMove?.();

    // rename() can't cross volumes. Fall back to copy, commit the
    // pointer, then remove the old tree. Symlinks (carry-over entries)
    // are copied as links, not followed.
    let copied = false;
    try {
      await rename(oldDir, newDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
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
      copied = true;
    }
    renamed = true;

    // Point both readers (app boot, CLI) at the new location. Atomic
    // rename so no reader can ever see a half-written path. Committed
    // before the old copy is deleted: if that cleanup fails midway, the
    // pointer already names the complete new copy -- leftovers beat a
    // boot against a half-deleted data dir. Moving to the default
    // removes the pointer instead, and the pre-2.0 pointer goes either
    // way: exactly one file may ever redirect a boot.
    if (toDefault) {
      await unlinkIfExists(pointerFile);
    } else {
      await rename(pointerTmp, pointerFile);
    }
    await unlinkIfExists(legacyPointerFile);
    if (copied) {
      await rm(oldDir, { recursive: true, force: true }).catch(() => undefined);
    }

    // Re-link git's worktree metadata (each worktree's .git file and
    // the repo's .git/worktrees/<name>/gitdir both record absolute
    // paths). Repair is idempotent and re-runnable from the repo by
    // hand, so a failure here shouldn't undo an otherwise complete
    // move.
    await Promise.all(
      repairTargets
        .filter(({ moved }) => moved.length > 0)
        .map(({ project, moved }) =>
          run(project.path, [
            "worktree",
            "repair",
            ...moved.map((m) => m.newPath),
          ]).catch(() => undefined),
        ),
    );
  } catch (err) {
    if (pointerStaged) await unlinkIfExists(pointerTmp).catch(() => undefined);
    if (rekeyed && !renamed) {
      await rekeyWorktrees(repairTargets, true).catch(() => undefined);
    }
    throw err;
  } finally {
    for (const id of marked) clearDeleteInflight(id);
  }
}

// Carries each moved worktree's shelf flag and data file from its old
// id to its new one (or back, on `reverse`). The relocate flow does
// the same for a single worktree (worktrees/relocate.ts).
async function rekeyWorktrees(
  targets: { project: { id: string }; moved: MovedWorktree[] }[],
  reverse: boolean,
): Promise<void> {
  for (const { project, moved } of targets) {
    for (const m of moved) {
      const [from, to] = reverse ? [m.newId, m.oldId] : [m.oldId, m.newId];
      if (isShelved(from)) {
        dropShelved(from);
        setShelved(to, true);
      }
      // oxlint-disable-next-line no-await-in-loop -- each step is a read-modify-write on the same files
      const data = await readWorktreeData(project.id, from);
      if (data) {
        // oxlint-disable-next-line no-await-in-loop -- see above
        await writeWorktreeData(project.id, to, data);
        // oxlint-disable-next-line no-await-in-loop -- see above
        await deleteWorktreeData(project.id, from);
      }
    }
  }
}
