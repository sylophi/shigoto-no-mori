// Background `git fetch` for every registered project so refs/remotes/*
// doesn't drift between explicit pulls. Triggered on app ready, on window
// focus, and on a slow periodic timer. Broadcasts GitRefsRefreshed when a
// fetch actually ran so the renderer can invalidate ref-dependent queries.
// The periodic sweep also refreshes the project-wide PR cache (sidebar
// dots); focus does not, since the open worktree page has its own
// fresher per-branch PR query.
import { BrowserWindow } from "electron";
import { CHANNELS, type ChannelName } from "@shared/channels";
import { fetchAllRemotes, snapshotRemoteRefs } from "./git";
import {
  pullRequestMapsEqual,
  readCachedProjectPullRequests,
  refreshProjectPullRequests,
} from "./githubCli";
import { loadProjects } from "./projects";

// Skip if a fetch finished within this window. Short enough that rapid
// focus events don't feel stale, long enough that the focus + sweep +
// pre-action paths collapse onto one network round-trip.
const FRESHNESS_MS = 3_000;

// Periodic sweep keeps refs fresh even when the user never refocuses.
const SWEEP_INTERVAL_MS = 60_000;

const lastFetchedAt = new Map<string, number>();
let sweepHandle: NodeJS.Timeout | null = null;

function broadcast<T>(channel: ChannelName, payload: T): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

async function maybeFetchProject(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const ts = lastFetchedAt.get(projectId) ?? 0;
  if (Date.now() - ts < FRESHNESS_MS) return;
  broadcast(CHANNELS.GitFetchActive, { projectId, active: true });
  try {
    const before = await snapshotRemoteRefs(projectPath);
    await fetchAllRemotes(projectPath);
    lastFetchedAt.set(projectId, Date.now());
    const after = await snapshotRemoteRefs(projectPath);
    if (before !== after) {
      broadcast(CHANNELS.GitRefsRefreshed, { projectId });
    }
  } catch {
    // Network/auth failure -- leave refs stale, surface elsewhere if it matters.
  } finally {
    broadcast(CHANNELS.GitFetchActive, { projectId, active: false });
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
      broadcast(CHANNELS.GithubCliProjectPullRequestsRefreshed, { projectId });
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
