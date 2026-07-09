// Resolves the on-disk layout for a project's managed worktrees. The
// chosen layout flows out of the per-project ShigomoriConfig; this module
// is the single source of truth for "where do new worktrees go?" and the
// matching "is this path one we manage?" check.

import { rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ShigomoriConfig, WorktreeLayout } from "@shared/schemas";
import { ALL_WORKTREE_LAYOUTS, worktreeBaseFor } from "@shared/worktreeLayout";
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

// Every base directory whose direct children count as "managed" for
// this project. All known layouts are included unconditionally so
// worktrees created under a previous layout still appear managed after
// the user switches, up until they run the migration.
export function managedBasesFor(
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
      }),
    ];
  });
}

// A worktree is managed when it sits DIRECTLY under one of the bases --
// the app only ever creates worktrees as `<base>/<name>`. Parent
// equality, not prefix matching: a prefix check would let a root base
// ("C:\", "/") claim every worktree on the volume, and managed status
// feeds destructive flows (nuke, delete cleanup).
export function isManagedPath(
  worktreePath: string,
  managedBases: string[],
): boolean {
  const folded = comparablePath(worktreePath).replace(/\/+$/, "");
  const cut = folded.lastIndexOf("/");
  if (cut < 0) return false;
  const parent = folded.slice(0, cut);
  return managedBases.some(
    (base) => parent === comparablePath(base).replace(/\/+$/, ""),
  );
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
