// Resolves the repo's .worktreeinclude file (Claude Code convention,
// https://code.claude.com/docs/en/worktrees): gitignore-syntax patterns
// whose matches, when also gitignored, are copied into new worktrees.
// Always copy mode, resolved fresh per worktree creation, never persisted.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isSafeRelPath,
  makeIgnoreMatcher,
  normalizeRelPath,
} from "@shared/gitPaths";
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

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

// Spec: a path is copied when it matches a .worktreeinclude pattern AND is
// gitignored. `--others` already excludes tracked files; the intersection
// with the standard ignored list drops untracked-but-not-ignored matches.
// A directory that is only partially gitignored collapses to `dir/` on the
// pattern side but appears as individual files on the ignored side, so the
// intersection drops it entirely — conservative, and avoids enumerating
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
  try {
    await readFile(join(projectPath, WORKTREE_INCLUDE_FILE));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
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

// Manual entries win on exact path collision — only reachable when the
// reconcile write failed and a covered manual entry survived; dropping the
// include duplicate avoids a spurious EEXIST failure from applyCarryOver.
export function mergeCarryOver(
  manual: CarryOverEntry[],
  include: CarryOverEntry[],
): CarryOverEntry[] {
  const manualPaths = new Set(manual.map((e) => normalizeRelPath(e.path)));
  return [...manual, ...include.filter((e) => !manualPaths.has(e.path))];
}

// Pure read for the Configure view. Never throws: a broken file or git
// failure degrades to an empty resolution so the UI can still render.
export async function readWorktreeIncludeStatus(
  projectPath: string,
): Promise<WorktreeIncludeStatus> {
  let raw: string;
  try {
    raw = await readFile(join(projectPath, WORKTREE_INCLUDE_FILE), "utf8");
  } catch {
    return { fileExists: false, patterns: [], resolvedPaths: [] };
  }
  const patterns = raw
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  let resolvedPaths: string[] = [];
  try {
    resolvedPaths = (await resolveMatchedPaths(projectPath)).map(
      stripTrailingSlash,
    );
  } catch {
    // Leave empty; creation-time resolution surfaces the real error.
  }
  return { fileExists: true, patterns, resolvedPaths };
}
