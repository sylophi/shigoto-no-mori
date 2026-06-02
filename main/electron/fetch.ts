// Background `git fetch` for every registered project so refs/remotes/*
// doesn't drift between explicit pulls. Triggered on app ready, on window
// focus, and on a slow periodic timer. Broadcasts GitRefsRefreshed when a
// fetch actually ran so the renderer can invalidate ref-dependent queries.
// The periodic sweep also refreshes the project-wide PR cache (sidebar
// dots); focus does not, since the open worktree page has its own
// fresher per-branch PR query.
import { gitContract } from "@shared/ipc/modules/git";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import { fetchAllRemotes, snapshotRemoteRefs } from "../lib/git/remotes";
import {
  pullRequestMapsEqual,
  readCachedProjectPullRequests,
  refreshProjectPullRequests,
} from "../lib/githubCli/pullRequests";
import { loadProjects } from "../lib/projects";
import { broadcastAll } from "../ipc/register";

// Skip if a fetch finished within this window. Short enough that rapid
// focus events don't feel stale, long enough that the focus + sweep +
// pre-action paths collapse onto one network round-trip.
const FRESHNESS_MS = 3_000;

// Periodic sweep keeps refs fresh even when the user never refocuses.
const SWEEP_INTERVAL_MS = 60_000;

const lastFetchedAt = new Map<string, number>();
let sweepHandle: NodeJS.Timeout | null = null;

export async function maybeFetchProject(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const ts = lastFetchedAt.get(projectId) ?? 0;
  if (Date.now() - ts < FRESHNESS_MS) return;
  broadcastAll(gitContract, "fetchActive", { projectId, active: true });
  try {
    const before = await snapshotRemoteRefs(projectPath);
    await fetchAllRemotes(projectPath);
    lastFetchedAt.set(projectId, Date.now());
    const after = await snapshotRemoteRefs(projectPath);
    if (before !== after) {
      broadcastAll(gitContract, "refsRefreshed", { projectId });
    }
  } catch {
    // Network/auth failure -- leave refs stale, surface elsewhere if it matters.
  } finally {
    broadcastAll(gitContract, "fetchActive", { projectId, active: false });
  }
}

async function sweepProjectPullRequests(
  projectId: string,
  projectPath: string,
): Promise<void> {
  try {
    const before = readCachedProjectPullRequests(projectPath);
    const after = await refreshProjectPullRequests(projectPath);
    if (!pullRequestMapsEqual(before, after)) {
      broadcastAll(githubCliContract, "projectPullRequestsRefreshed", {
        projectId,
      });
    }
  } catch {
    // PR data is decorative; swallow.
  }
}

// Git-only refresh used by the window-focus handler. The PR sweep is
// timer-driven only -- the open worktree page has its own per-branch
// query that handles focus.
export function refreshAllProjectGitRefs(): void {
  for (const project of loadProjects()) {
    void maybeFetchProject(project.id, project.path);
  }
}

function sweepAllProjects(): void {
  for (const project of loadProjects()) {
    void maybeFetchProject(project.id, project.path);
    void sweepProjectPullRequests(project.id, project.path);
  }
}

export function startBackgroundFetch(): void {
  if (sweepHandle) return;
  sweepAllProjects();
  sweepHandle = setInterval(sweepAllProjects, SWEEP_INTERVAL_MS);
}
