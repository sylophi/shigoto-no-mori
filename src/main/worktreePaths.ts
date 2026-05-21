// Resolves the on-disk layout for a project's managed worktrees. The
// chosen layout flows out of the per-project ShigomoriConfig; this module
// is the single source of truth for "where do new worktrees go?" and the
// matching "is this path one we manage?" check.

import { basename, join, sep } from "node:path";
import type { ShigomoriConfig, WorktreeLayout } from "@shared/schemas";
import { worktreeBaseFor } from "@shared/worktreeLayout";
import { shigomoriRoot } from "./paths";

const IN_PROJECT_SUBDIR = ".shigomori/worktrees";

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
// We always include the managed-root prefix and the in-project prefix so
// worktrees created under a previous layout still appear managed after
// the user switches — until they run the migration. Custom path joins in
// when configured.
export function managedPrefixesFor(
  projectPath: string,
  config: ShigomoriConfig | null,
): string[] {
  const prefixes = [
    join(shigomoriRoot(), "worktrees", basename(projectPath)) + sep,
    join(projectPath, IN_PROJECT_SUBDIR) + sep,
  ];
  const custom = config?.customWorktreePath?.trim();
  if (custom) prefixes.push(custom + sep);
  return prefixes;
}

export function isManagedPath(
  worktreePath: string,
  managedPrefixes: string[],
): boolean {
  return managedPrefixes.some((p) => worktreePath.startsWith(p));
}
