import { readStored, writeStored } from "@/lib/localStorage";
// Per-project most-recently-used worktree, so the project launcher can jump
// straight to where the user last was. localStorage-only: worktree usage is
// not tracked in the main process (project usage stats are per-project), and
// a renderer-side record is enough — a stale or missing id just falls back.
const KEY = "recentWorktree.byProject";

function readMap(): Record<string, string> {
  const raw = readStored(KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
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
