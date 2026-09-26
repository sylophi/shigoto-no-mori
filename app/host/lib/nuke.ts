// "Nuke everything" implementation: removes every worktree shigomori created
// (through `sm rm --force`, so each one's port-pool lease is released and
// its teardown runs like any other removal) and wipes the shigomori data
// dir so state, global config, and any orphan worktree directories all go
// away.
//
// The original project repos on disk are untouched. We only act on data
// shigomori itself owns.
import { rm } from "node:fs/promises";
import type { NukeProgress, Project } from "@shared/schemas";
import { errorMessageOf } from "@shared/errors";
import { forceRemoveViaCli } from "@host/ipc/cliDelegate";
import { ensureDataDir } from "./bootstrap";
import { invalidateGlobalConfigCache } from "./config/global";
import { listWorktreeIdentities, pruneStaleWorktrees } from "./git/worktrees";
import {
  findProjectInsideDataDir,
  listProjects,
  refreshProjects,
} from "./projects";
import {
  clearDeleteInflight,
  killAllScripts,
  markDeleteInflight,
} from "./scripts";
import { dataDir, dataDirSource, defaultDataDir } from "./util/paths";

export async function nukeEverything(
  onProgress: (progress: NukeProgress) => void = () => {},
): Promise<void> {
  const projects = await listProjects();
  // The final step rm -rf's the shigomori data dir. A trapped project repo
  // would be wiped with it: .git, uncommitted work, everything.
  // Refuse up front, before any script kill or worktree removal.
  const trapped = findProjectInsideDataDir(projects);
  if (trapped) {
    throw new Error(
      `Refusing to nuke: project "${trapped.name}" lives inside ` +
        `${dataDir()}, which would be deleted with it. ` +
        "Move the repository out first.",
    );
  }
  // Reap every running script first. Dev servers and watchers may have
  // their cwd inside the worktrees we're about to force-remove. Skipping
  // this would orphan them with deleted working directories, still
  // holding their ports, exactly what the per-worktree delete path
  // guards against via killScriptsForWorktree.
  onProgress({ phase: "scripts" });
  await killAllScripts();

  // List every project's worktrees up front so all targets can be
  // marked delete-inflight for the whole wipe. Skip externals:
  // shigomori didn't create them, so we shouldn't delete them when
  // wiping our own state. (sm rm filters their branches the same way.)
  const perProject = await Promise.all(
    projects.map(async (project) => {
      try {
        const identities = await listWorktreeIdentities(project.id);
        return {
          project,
          targets: identities.filter((i) => !i.isPrimary && !i.isExternal),
        };
      } catch {
        // Project repo might have moved or been deleted; nothing to clean
        // via git for this one. The data dir wipe below still happens.
        return { project, targets: [] };
      }
    }),
  );
  // Same inflight marking as the per-worktree delete: blocks a renderer
  // script run from landing in a directory mid-removal and keeps the
  // busy-quit prompt honest during the wipe. Held through the data dir rm
  // below. Clearing each id right after its removal
  // would leave a window where a script could spawn into a directory
  // the rm is about to take out.
  const marked = perProject.flatMap(({ targets }) => targets.map((t) => t.id));
  for (const id of marked) markDeleteInflight(id);
  try {
    let removed = 0;
    onProgress({ phase: "worktrees", done: 0, total: marked.length });
    // react-doctor-disable-next-line react-doctor/async-parallel -- per-project fan-out → rm dataDir → prune is sequential by design
    await Promise.all(
      perProject.map(async ({ project, targets }) => {
        // One removal at a time within a project: each one rewrites the
        // repo's worktree metadata and branch refs.
        for (const target of targets) {
          // oxlint-disable-next-line no-await-in-loop -- one repo, one writer at a time (see above)
          await removeForNuke(project, target.id);
          removed += 1;
          onProgress({
            phase: "worktrees",
            done: removed,
            total: marked.length,
          });
        }
      }),
    );
    onProgress({ phase: "wipe" });
    await rm(dataDir(), { recursive: true, force: true });
  } finally {
    for (const id of marked) clearDeleteInflight(id);
  }
  // config.json is gone but the TTL cache would keep serving the old
  // preferences; drop it so post-nuke reads see a clean slate.
  invalidateGlobalConfigCache();
  // Reseed an empty data dir right away (launch-time bootstrap won't run
  // again this session): renderer refetches read a fresh valid layout,
  // and a stray state write can't resurrect a half-empty data dir.
  // A data dir adopted under its pre-2.0 name is the exception: the
  // fresh install is seeded at the default location instead, so the
  // next boot lands there rather than adopting the old name again.
  // The renderer relaunches right after a nuke in that case.
  await ensureDataDir(
    dataDirSource() === "legacy" ? defaultDataDir() : dataDir(),
  );
  // The data dir rm wipes any managed-root worktree dirs whose removal
  // failed above, leaving stale admin entries behind. Sweep them per
  // project now that the dirs are gone.
  await Promise.all(
    projects.map((p) => pruneStaleWorktrees(p.path).catch(() => undefined)),
  );
  // The registry went with the data dir.
  await refreshProjects().catch(() => undefined);
}

// Through forceRemoveViaCli: the branch goes per the
// deleteBranchOnRemove setting, as with any removal. Best effort: the
// data dir wipe that follows takes whatever is left under the managed
// root.
async function removeForNuke(project: Project, worktreeId: string) {
  try {
    await forceRemoveViaCli(project, worktreeId);
  } catch (error) {
    console.warn(`[nuke] ${project.name}: ${errorMessageOf(error)}`);
  }
}
