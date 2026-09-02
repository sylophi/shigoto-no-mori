// Resolves the repo's .worktreeinclude file (Claude Code convention,
// https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees):
// gitignore-syntax patterns
// whose matches, when also gitignored, are copied into new worktrees.
// Creation-time application lives in the CLI engine. This module only
// backs the Configure view's read.

import { join } from "node:path";
import { makeIgnoreMatcher, normalizeRelPath } from "@shared/gitPaths";
import { pathExists } from "../util/paths";
import type { WorktreeIncludeStatus } from "@shared/schemas";
import {
  listIgnoredPaths,
  listUntrackedMatchingExcludeFile,
} from "../git/branches";
import { listCarryOverCheckouts } from "./carryOver";

const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

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
  return candidates.filter((c) => isIgnored(normalizeRelPath(c)));
}

// Pure read for the Configure view. Never throws: a broken file or git
// failure degrades to an empty resolution so the UI can still render.
// matchedPaths keep git's raw shape (directories keep their trailing
// slash) so the renderer's coverage matcher sees the same input as
// creation-time reconciliation.
//
// Every checkout's own .worktreeinclude counts, resolved against that
// checkout's gitignore and unioned, the same way the CLI resolves it at
// creation (resolveWorktreeIncludeAcross in cli/carryover.go). So a
// pattern that only exists on a feature branch's worktree still shows
// up as covered here.
export async function readWorktreeIncludeStatus(
  projectId: string,
  projectPath: string,
): Promise<WorktreeIncludeStatus> {
  const checkouts = await listCarryOverCheckouts(projectId, projectPath);
  const perCheckout = await Promise.all(
    checkouts.map((checkout) => readOneStatus(checkout.path)),
  );
  return {
    fileExists: perCheckout.some((status) => status.fileExists),
    matchedPaths: [...new Set(perCheckout.flatMap((s) => s.matchedPaths))],
  };
}

async function readOneStatus(
  checkoutPath: string,
): Promise<WorktreeIncludeStatus> {
  if (!(await pathExists(join(checkoutPath, WORKTREE_INCLUDE_FILE)))) {
    return { fileExists: false, matchedPaths: [] };
  }
  let matchedPaths: string[] = [];
  try {
    matchedPaths = await resolveMatchedPaths(checkoutPath);
  } catch {
    // Leave empty; creation-time resolution surfaces the real error.
  }
  return { fileExists: true, matchedPaths };
}
