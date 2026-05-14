// "Nuke everything" implementation: removes every worktree shigomori created
// (via `git worktree remove --force`) and wipes the shigomori root so state,
// global config, and any orphan worktree directories all go away.
//
// The original project repos on disk are untouched — we only act on data
// shigomori itself owns.
import { rm } from "node:fs/promises";
import {
  deleteLocalBranch,
  listWorktreeIdentities,
  removeWorktree,
} from "./git";
import { readGlobalConfig } from "./globalConfig";
import { shigomoriRoot } from "./paths";
import { loadProjects } from "./projects";

export async function nukeEverything(): Promise<void> {
  const projects = loadProjects();
  const deleteBranches = await readGlobalConfig()
    .then((c) => c.deleteBranchOnRemove ?? false)
    .catch(() => false);

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
      const targets = identities.filter((i) => !i.isPrimary);
      await Promise.all(
        targets.map((i) =>
          removeWorktree(project.path, i.path, true).catch(() => undefined),
        ),
      );
      if (deleteBranches) {
        await Promise.all(
          targets
            .filter((i) => i.branch && i.branch !== "(unknown)")
            .map((i) =>
              deleteLocalBranch(project.path, i.branch).catch(() => undefined),
            ),
        );
      }
    }),
  );
  await rm(shigomoriRoot(), { recursive: true, force: true });
}
