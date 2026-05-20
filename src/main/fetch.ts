// Background `git fetch` for every registered project so refs/remotes/*
// doesn't drift between explicit pulls. Triggered on app ready, on window
// focus, and on a slow periodic timer. Broadcasts GitRefsRefreshed when a
// fetch actually ran so the renderer can invalidate ref-dependent queries.
import { BrowserWindow } from "electron";
import { CHANNELS } from "@shared/channels";
import { fetchAllRemotes, snapshotRemoteRefs } from "./git";
import { loadProjects } from "./projects";

// Skip if a fetch finished within this window. Short enough that rapid
// focus events don't feel stale, long enough that the focus + sweep +
// pre-action paths collapse onto one network round-trip.
const FRESHNESS_MS = 3_000;

// Periodic sweep keeps refs fresh even when the user never refocuses.
const SWEEP_INTERVAL_MS = 60_000;

const lastFetchedAt = new Map<string, number>();
let sweepHandle: NodeJS.Timeout | null = null;

function broadcastRefsRefreshed(projectId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.GitRefsRefreshed, { projectId });
  }
}

async function maybeFetchProject(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const ts = lastFetchedAt.get(projectId) ?? 0;
  if (Date.now() - ts < FRESHNESS_MS) return;
  try {
    const before = await snapshotRemoteRefs(projectPath);
    await fetchAllRemotes(projectPath);
    lastFetchedAt.set(projectId, Date.now());
    const after = await snapshotRemoteRefs(projectPath);
    if (before !== after) broadcastRefsRefreshed(projectId);
  } catch {
    // Network/auth failure -- leave refs stale, surface elsewhere if it matters.
  }
}

export function refreshAllProjects(): void {
  for (const project of loadProjects()) {
    void maybeFetchProject(project.id, project.path);
  }
}

export function startBackgroundFetch(): void {
  if (sweepHandle) return;
  refreshAllProjects();
  sweepHandle = setInterval(refreshAllProjects, SWEEP_INTERVAL_MS);
}
