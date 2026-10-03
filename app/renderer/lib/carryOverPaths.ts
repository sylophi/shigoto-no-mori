// The .worktreeinclude matches that join a project's carry-over list
// beside its manual entries: normalized, and dropped where a manual
// entry names the same path (the manual row wins and carries the
// covered badge until creation-time reconciliation removes it). One
// rule, so the Configure page and the transplant review agree on what
// a new worktree gets.
import { normalizeRelPath } from "@shared/git/gitPaths";
import type {
  CarryOverEntry,
  ShigomoriConfig,
  WorktreeIncludeStatus,
} from "@shared/schemas";

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

// One carry-over path and how it travels (copy, symlink, include).
export type CarryOverItem = { path: string; tag: string };

// A project's carry-over as a create lists it: the manual entries, then
// the .worktreeinclude matches that join them.
export function carryOverItems(
  config: Pick<ShigomoriConfig, "carryOver" | "useWorktreeInclude"> | null,
  include: WorktreeIncludeStatus | null | undefined,
): CarryOverItem[] {
  const manual = config?.carryOver ?? [];
  const included = worktreeIncludeExtras(
    manual,
    config?.useWorktreeInclude !== false,
    include,
  );
  return [
    ...manual.map((entry) => ({ path: entry.path, tag: entry.mode as string })),
    ...included.map((path) => ({ path, tag: "include" })),
  ];
}
