// "Nuke everything" implementation: removes every worktree shigomori created
// (via `git worktree remove --force`) and wipes the shigomori root so state,
// global config, and any orphan worktree directories all go away.
//
// The original project repos on disk are untouched — we only act on data
// shigomori itself owns.
import { rm } from "node:fs/promises";
import {
  deleteBranchAfterWorktreeRemoval,
  listWorktreeIdentities,
  pruneStaleWorktrees,
  removeWorktreeForce,
} from "../git";
import { readGlobalConfig } from "../config/global";
import { shigomoriRoot } from "../util/paths";
import { loadProjects } from "../projects";

export async function nukeEverything(): Promise<void> {
  const projects = loadProjects();
  const deleteBranches = await readGlobalConfig()
    .then((c) => c.deleteBranchOnRemove ?? true)
    .catch(() => true);

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
      await Promise.all(
        targets.map((i) =>
          removeWorktreeForce(project.path, i.path).catch(() => undefined),
        ),
      );
      await Promise.all(
        targets.map((i) =>
          deleteBranchAfterWorktreeRemoval(project.path, i, deleteBranches),
        ),
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
