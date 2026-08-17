// Resolves the repo's .worktreeinclude file (Claude Code convention,
// https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees):
// gitignore-syntax patterns
// whose matches, when also gitignored, are copied into new worktrees.
// Creation-time application lives in the CLI engine; this module only
// backs the Configure view's read.

import { join } from "node:path";
import { makeIgnoreMatcher } from "@shared/gitPaths";
import { pathExists } from "../util/paths";
import type { WorktreeIncludeStatus } from "@shared/schemas";
import {
  listIgnoredPaths,
  listUntrackedMatchingExcludeFile,
} from "../git/branches";

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

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
