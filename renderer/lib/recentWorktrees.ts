import { readStoredJson, writeStored } from "@/lib/localStorage";
// Per-project most-recently-used worktree, so the project launcher can jump
// straight to where the user last was. localStorage-only: worktree usage is
// not tracked in the main process (project usage stats are per-project), and
// a renderer-side record is enough. A stale or missing id just falls back.
const KEY = "recentWorktree.byProject";

function readMap(): Record<string, string> {
  return readStoredJson<Record<string, string>>(KEY, {});
}

export function recordRecentWorktree(
  projectId: string,
  worktreeId: string,
): void {
  const map = readMap();
  if (map[projectId] === worktreeId) return;
  map[projectId] = worktreeId;
  writeStored(KEY, JSON.stringify(map));
}

export function getRecentWorktree(projectId: string): string | null {
  const id = readMap()[projectId];
  return typeof id === "string" ? id : null;
}

// When each worktree was last opened in this window, across every
// project and device, for the worktree palette's order: where you were
// last floats to the top. Keyed by the sidebar's row key (worktreeRowKey,
// device-qualified for a peer's, since the same repo on two machines
// can carry the same worktree id), and trimmed to the newest few so the
// record can't grow without bound.
const VISITS_KEY = "recentWorktree.visits";
const MAX_VISITS = 100;

export function readWorktreeVisits(): Record<string, number> {
  return readStoredJson<Record<string, number>>(VISITS_KEY, {});
}

export function recordWorktreeVisit(rowKey: string): void {
  const visits = readWorktreeVisits();
  visits[rowKey] = Date.now();
  const newest = Object.entries(visits)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, MAX_VISITS);
  writeStored(VISITS_KEY, JSON.stringify(Object.fromEntries(newest)));
}
