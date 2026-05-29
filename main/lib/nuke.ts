// "Nuke everything" implementation: removes every worktree shigomori created
// (via `git worktree remove --force`) and wipes the shigomori root so state,
// global config, and any orphan worktree directories all go away.
//
// The original project repos on disk are untouched — we only act on data
// shigomori itself owns.
import { rm } from "node:fs/promises";
import { readGlobalConfig } from "./config/global";
import { deleteBranchAfterWorktreeRemoval } from "./git/branches";
import {
  listWorktreeIdentities,
  pruneStaleWorktrees,
  removeWorktreeForce,
} from "./git/worktrees";
import { loadProjects } from "./projects";
import { shigomoriRoot } from "./util/paths";

export async function nukeEverything(): Promise<void> {
  const projects = loadProjects();
  // Kick off the config read in parallel with the per-project worktree work.
  // deleteBranches is only needed inside the inner branch-cleanup step, so we
  // don't have to block the outer fan-out on it.
  const deleteBranchesPromise = readGlobalConfig()
    .then((c) => c.deleteBranchOnRemove ?? true)
    .catch(() => true);

  // react-doctor-disable-next-line react-doctor/async-parallel -- per-project fan-out → rm shigomoriRoot → prune is sequential by design
  await Promise.all(
    projects.map(async (project) => {
      let identities;
      try {
        identities = await listWorktreeIdentities(project.id, project.path);
      } catch {
        // Project repo might have moved or been deleted; nothing to clean
        // via git for this one. The shigomori root wipe below still happens.
        return;
      }
      // Skip externals: shigomori didn't create them, so we shouldn't
      // delete them when wiping our own state. (Branches are filtered
      // the same way inside deleteBranchAfterWorktreeRemoval.)
      const targets = identities.filter((i) => !i.isPrimary && !i.isExternal);
      const deleteBranches = await deleteBranchesPromise;
      await Promise.all(
        targets.map(async (i) => {
          await removeWorktreeForce(project.path, i.path).catch(
            () => undefined,
          );
          await deleteBranchAfterWorktreeRemoval(
            project.path,
            i,
            deleteBranches,
          );
        }),
      );
    }),
  );
  await rm(shigomoriRoot(), { recursive: true, force: true });
  // The root rm wipes any managed-root worktree dirs whose
  // `git worktree remove` failed silently above, leaving stale admin
  // entries behind. Sweep them per project now that the dirs are gone.
  await Promise.all(
    projects.map((p) => pruneStaleWorktrees(p.path).catch(() => undefined)),
  );
}
