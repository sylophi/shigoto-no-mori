// Resolves the on-disk layout for a project's managed worktrees. The
// chosen layout flows out of the per-project ShigomoriConfig; this module
// is the single source of truth for "where do new worktrees go?" and the
// matching "is this path one we manage?" check.

import { sep } from "node:path";
import type { ShigomoriConfig, WorktreeLayout } from "@shared/schemas";
import { ALL_WORKTREE_LAYOUTS, worktreeBaseFor } from "@shared/worktreeLayout";
import { shigomoriRoot } from "./paths";

export function layoutOf(config: ShigomoriConfig | null): WorktreeLayout {
  return config?.worktreeLayout ?? "managed-root";
}

export function resolveWorktreeBase(
  projectPath: string,
  config: ShigomoriConfig | null,
): string {
  return worktreeBaseFor({
    layout: layoutOf(config),
    projectPath,
    shigomoriRoot: shigomoriRoot(),
    customPath: config?.customWorktreePath ?? null,
  });
}

// Every path prefix that should count as "managed" for this project.
// All known layouts are included unconditionally so worktrees created
// under a previous layout still appear managed after the user switches,
// up until they run the migration.
export function managedPrefixesFor(
  projectPath: string,
  config: ShigomoriConfig | null,
): string[] {
  const customPath = config?.customWorktreePath?.trim() ?? null;
  return ALL_WORKTREE_LAYOUTS.flatMap((layout) => {
    if (layout === "custom" && !customPath) return [];
    return [
      worktreeBaseFor({
        layout,
        projectPath,
        shigomoriRoot: shigomoriRoot(),
        customPath,
      }) + sep,
    ];
  });
}

export function isManagedPath(
  worktreePath: string,
  managedPrefixes: string[],
): boolean {
  return managedPrefixes.some((p) => worktreePath.startsWith(p));
}
