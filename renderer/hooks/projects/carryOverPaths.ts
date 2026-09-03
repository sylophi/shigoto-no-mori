// The .worktreeinclude matches that join a project's carry-over list
// beside its manual entries: normalized, and dropped where a manual
// entry names the same path (the manual row wins and carries the
// covered badge until creation-time reconciliation removes it). One
// rule, so the Configure page and the transplant review agree on what
// a new worktree gets.
import { normalizeRelPath } from "@shared/gitPaths";
import type { CarryOverEntry, WorktreeIncludeStatus } from "@shared/schemas";

export function worktreeIncludeExtras(
  entries: CarryOverEntry[],
  useWorktreeInclude: boolean,
  status: WorktreeIncludeStatus | null | undefined,
): string[] {
  if (!useWorktreeInclude || !status?.fileExists) return [];
  const manualPaths = new Set(entries.map((e) => normalizeRelPath(e.path)));
  return status.matchedPaths.flatMap((raw) => {
    const p = normalizeRelPath(raw);
    return manualPaths.has(p) ? [] : [p];
  });
}
