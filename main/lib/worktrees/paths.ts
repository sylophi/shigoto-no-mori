// Resolves the on-disk layout for a project's managed worktrees. The
// chosen layout flows out of the per-project ShigomoriConfig; this module
// is the single source of truth for "where do new worktrees go?" and the
// matching "is this path one we manage?" check.

import { rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ShigomoriConfig, WorktreeLayout } from "@shared/schemas";
import {
  ALL_WORKTREE_LAYOUTS,
  withTrailingSep,
  worktreeBaseFor,
} from "@shared/worktreeLayout";
import { comparablePath, shigomoriRoot } from "../util/paths";

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
    // withTrailingSep, not `+ sep`: a drive-root custom base ("C:\")
    // already ends with its separator, and doubling it ("C:\\") folds
    // to a prefix no real path starts with. It also keeps the base's
    // own separator style instead of forcing the host's.
    return [
      withTrailingSep(
        worktreeBaseFor({
          layout,
          projectPath,
          shigomoriRoot: shigomoriRoot(),
          customPath,
        }),
      ),
    ];
  });
}

export function isManagedPath(
  worktreePath: string,
  managedPrefixes: string[],
): boolean {
  const target = comparablePath(worktreePath);
  return managedPrefixes.some((p) => target.startsWith(comparablePath(p)));
}

// Best-effort cleanup of the empty parent directory a worktree just
// vacated (after a relocate or removal). Only touches paths shigomori
// owns:
//   - managed-root: `<shigomoriRoot>/worktrees/<projectName>/`
//   - in-project:   `<project>/.shigomori/worktrees/`, then `.shigomori/`
// The custom layout is intentionally left alone since that directory is
// user-chosen and could sit next to unrelated files. `rmdir` errors with
// ENOTEMPTY when the directory still has siblings, which we swallow so
// concurrent relocates don't race.
export async function pruneEmptyManagedParents(
  oldWorktreePath: string,
  projectPath: string,
): Promise<void> {
  const parent = dirname(oldWorktreePath);

  const managedRootBase = join(
    shigomoriRoot(),
    "worktrees",
    basename(projectPath),
  );
  if (comparablePath(parent) === comparablePath(managedRootBase)) {
    await tryRmdir(parent);
    return;
  }

  const inProjectBase = join(projectPath, ".shigomori", "worktrees");
  if (comparablePath(parent) === comparablePath(inProjectBase)) {
    const removed = await tryRmdir(parent);
    if (removed) {
      await tryRmdir(dirname(parent));
    }
  }
}

async function tryRmdir(path: string): Promise<boolean> {
  try {
    await rmdir(path);
    return true;
  } catch {
    return false;
  }
}
