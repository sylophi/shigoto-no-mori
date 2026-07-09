// Resolves the repo's .worktreeinclude file (Claude Code convention,
// https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees):
// gitignore-syntax patterns
// whose matches, when also gitignored, are copied into new worktrees.
// Always copy mode, resolved fresh per worktree creation, never persisted.

import { join } from "node:path";
import {
  isSafeRelPath,
  makeIgnoreMatcher,
  normalizeRelPath,
} from "@shared/gitPaths";
import { pathExists } from "../util/paths";
import type {
  CarryOverEntry,
  ShigomoriConfig,
  WorktreeIncludeStatus,
} from "@shared/schemas";
import {
  listIgnoredPaths,
  listUntrackedMatchingExcludeFile,
} from "../git/branches";

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

export interface WorktreeIncludeResolution {
  // Copy-mode entries to apply, trailing slashes stripped.
  entries: CarryOverEntry[];
  // Raw matched paths (directories keep their trailing slash) so callers
  // can build a coverage matcher over the same shape git emitted.
  matchedPaths: string[];
}

// Spec: a path is copied when it matches a .worktreeinclude pattern AND is
// gitignored. `--others` already excludes tracked files; the intersection
// with the standard ignored list drops untracked-but-not-ignored matches.
// A directory that is only partially gitignored collapses to `dir/` on the
// pattern side but appears as individual files on the ignored side, so the
// intersection drops it entirely: conservative, and avoids enumerating
// node_modules-scale trees.
async function resolveMatchedPaths(projectPath: string): Promise<string[]> {
  const [candidates, ignored] = await Promise.all([
    listUntrackedMatchingExcludeFile(
      projectPath,
      join(projectPath, WORKTREE_INCLUDE_FILE),
    ),
    listIgnoredPaths(projectPath),
  ]);
  const isIgnored = makeIgnoreMatcher(ignored);
  return candidates.filter((c) => isIgnored(stripTrailingSlash(c)));
}

function stripTrailingSlash(p: string): string {
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

// null = nothing to do (toggle off, or no .worktreeinclude in the repo).
// Git/fs errors propagate; the caller owns the best-effort policy.
export async function resolveWorktreeInclude(
  projectPath: string,
  config: ShigomoriConfig | null,
): Promise<WorktreeIncludeResolution | null> {
  if (config?.useWorktreeInclude === false) return null;
  if (!(await pathExists(join(projectPath, WORKTREE_INCLUDE_FILE)))) {
    return null;
  }
  const matchedPaths = await resolveMatchedPaths(projectPath);
  const entries = matchedPaths
    .map(stripTrailingSlash)
    .filter((p) => p.length > 0 && isSafeRelPath(p))
    .map((path): CarryOverEntry => ({ path, mode: "copy" }));
  return { entries, matchedPaths };
}

// Manual entries now covered by .worktreeinclude are auto-removed (user
// decision: the file wins, regardless of the entry's mode).
export function reconcileManualEntries(
  manual: CarryOverEntry[],
  matchedPaths: string[],
): { kept: CarryOverEntry[]; removedPaths: string[] } {
  const covered = makeIgnoreMatcher(matchedPaths);
  const kept: CarryOverEntry[] = [];
  const removedPaths: string[] = [];
  for (const entry of manual) {
    if (covered(normalizeRelPath(entry.path))) removedPaths.push(entry.path);
    else kept.push(entry);
  }
  return { kept, removedPaths };
}

// Manual entries win when an include path collides with or overlaps a
// manual path. Exact collisions are only reachable when the reconcile
// write failed and a covered manual entry survived. Nested overlaps are
// reachable normally: a manual entry for a partially-gitignored directory
// survives reconciliation while the file's patterns match ignored files
// inside it, and applyCarryOver runs entries concurrently, so applying
// both races the parent against the child (spurious EEXIST failures).
export function mergeCarryOver(
  manual: CarryOverEntry[],
  include: CarryOverEntry[],
): CarryOverEntry[] {
  const manualPaths = manual.map((e) => normalizeRelPath(e.path));
  return [
    ...manual,
    ...include.filter((e) => !manualPaths.some((m) => pathsOverlap(e.path, m))),
  ];
}

// True when the paths are equal or one is nested inside the other.
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// Pure read for the Configure view. Never throws: a broken file or git
// failure degrades to an empty resolution so the UI can still render.
// matchedPaths keep git's raw shape (directories keep their trailing
// slash) so the renderer's coverage matcher sees the same input as
// creation-time reconciliation.
export async function readWorktreeIncludeStatus(
  projectPath: string,
): Promise<WorktreeIncludeStatus> {
  if (!(await pathExists(join(projectPath, WORKTREE_INCLUDE_FILE)))) {
    return { fileExists: false, matchedPaths: [] };
  }
  let matchedPaths: string[] = [];
  try {
    matchedPaths = await resolveMatchedPaths(projectPath);
  } catch {
    // Leave empty; creation-time resolution surfaces the real error.
  }
  return { fileExists: true, matchedPaths };
}
