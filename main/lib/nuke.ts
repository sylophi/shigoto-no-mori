// "Nuke everything" implementation: removes every worktree shigomori created
// (via `git worktree remove --force`) and wipes the shigomori root so state,
// global config, and any orphan worktree directories all go away.
//
// The original project repos on disk are untouched -- we only act on data
// shigomori itself owns.
import { rm } from "node:fs/promises";
import { invalidateGlobalConfigCache, readGlobalConfig } from "./config/global";
import { deleteBranchAfterWorktreeRemoval } from "./git/branches";
import {
  listWorktreeIdentities,
  pruneStaleWorktrees,
  removeWorktreeForce,
} from "./git/worktrees";
import { loadProjects } from "./projects";
import {
  clearDeleteInflight,
  killAllScripts,
  markDeleteInflight,
} from "./scripts";
import { comparablePath, shigomoriRoot, toAbsolute } from "./util/paths";

export async function nukeEverything(): Promise<void> {
  const projects = loadProjects();
  // The final step rm -rf's the shigomori root. A project repo the user
  // keeps INSIDE that root (nothing stops projects.add from accepting
  // one) would be wiped with it -- .git, uncommitted work, everything.
  // Refuse up front, before any script kill or worktree removal.
  const root = comparablePath(shigomoriRoot()).replace(/\/+$/, "");
  const trapped = projects.find((p) => {
    const folded = comparablePath(toAbsolute(p.path)).replace(/\/+$/, "");
    return folded === root || folded.startsWith(`${root}/`);
  });
  if (trapped) {
    throw new Error(
      `Refusing to nuke: project "${trapped.name}" lives inside ` +
        `${shigomoriRoot()}, which would be deleted with it. ` +
        "Move the repository out first.",
    );
  }
  // Reap every running script first -- dev servers and watchers may have
  // their cwd inside the worktrees we're about to force-remove. Skipping
  // this would orphan them with deleted working directories, still
  // holding their ports, exactly what the per-worktree delete path
  // guards against via killScriptsForWorktree.
  await killAllScripts();
  // Kick off the config read in parallel with the per-project worktree work.
  // deleteBranches is only needed inside the inner branch-cleanup step, so we
  // don't have to block the outer fan-out on it.
  const deleteBranchesPromise = readGlobalConfig()
    .then((c) => c.deleteBranchOnRemove ?? true)
    .catch(() => true);

  // List every project's worktrees up front so all targets can be
  // marked delete-inflight for the whole wipe. Skip externals:
  // shigomori didn't create them, so we shouldn't delete them when
  // wiping our own state. (Branches are filtered the same way inside
  // deleteBranchAfterWorktreeRemoval.)
  const perProject = await Promise.all(
    projects.map(async (project) => {
      try {
        const identities = await listWorktreeIdentities(
          project.id,
          project.path,
        );
        return {
          project,
          targets: identities.filter((i) => !i.isPrimary && !i.isExternal),
        };
      } catch {
        // Project repo might have moved or been deleted; nothing to clean
        // via git for this one. The shigomori root wipe below still happens.
        return { project, targets: [] };
      }
    }),
  );
  // Same inflight marking as the per-worktree delete: blocks a renderer
  // script run from landing in a directory mid-removal and keeps the
  // busy-quit prompt honest during the wipe. Held through the root rm
  // below -- clearing each id right after its `git worktree remove`
  // would leave a window where a script could spawn into a directory
  // the rm is about to take out.
  const marked = perProject.flatMap(({ targets }) => targets.map((t) => t.id));
  for (const id of marked) markDeleteInflight(id);
  try {
    // react-doctor-disable-next-line react-doctor/async-parallel -- per-project fan-out → rm shigomoriRoot → prune is sequential by design
    await Promise.all(
      perProject.map(async ({ project, targets }) => {
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
  } finally {
    for (const id of marked) clearDeleteInflight(id);
  }
  // config.json is gone but the TTL cache would keep serving the old
  // preferences; drop it so post-nuke reads see a clean slate.
  invalidateGlobalConfigCache();
  // The root rm wipes any managed-root worktree dirs whose
  // `git worktree remove` failed silently above, leaving stale admin
  // entries behind. Sweep them per project now that the dirs are gone.
  await Promise.all(
    projects.map((p) => pruneStaleWorktrees(p.path).catch(() => undefined)),
  );
}
