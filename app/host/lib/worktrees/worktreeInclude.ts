// Resolves the repo's .worktreeinclude file (Claude Code convention,
// https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees):
// gitignore-syntax patterns
// whose matches, when also gitignored, are copied into new worktrees.
// Creation-time application lives in the CLI engine. This module only
// backs the Configure view's read.

import { join } from "node:path";
import * as Effect from "effect/Effect";
import {
  makeIgnoreMatcher,
  normalizeRelPath,
} from "@shigomori/contracts/git/gitPaths";
import { pathExists } from "../util/paths";
import type { WorktreeIncludeStatus } from "@shigomori/contracts/schemas";
import {
  listIgnoredPaths,
  listUntrackedMatchingExcludeFile,
} from "../git/branches";
import type { CarryOverCheckout } from "./carryOver";

const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

// Spec: a path is copied when it matches a .worktreeinclude pattern AND is
// gitignored. `--others` already excludes tracked files; the intersection
// with the standard ignored list drops untracked-but-not-ignored matches.
// A directory that is only partially gitignored collapses to `dir/` on the
// pattern side but appears as individual files on the ignored side, so the
// intersection drops it entirely: conservative, and avoids enumerating
// node_modules-scale trees.
const resolveMatchedPaths = (projectPath: string) =>
  Effect.map(
    Effect.all(
      [
        listUntrackedMatchingExcludeFile(
          projectPath,
          join(projectPath, WORKTREE_INCLUDE_FILE),
        ),
        listIgnoredPaths(projectPath),
      ],
      { concurrency: 2 },
    ),
    ([candidates, ignored]) => {
      const isIgnored = makeIgnoreMatcher(ignored);
      return candidates.filter((c) => isIgnored(normalizeRelPath(c)));
    },
  );

// Pure read for the Configure view. Never throws: a broken file or git
// failure degrades to an empty resolution so the UI can still render.
// matchedPaths keep git's raw shape (directories keep their trailing
// slash) so the renderer's coverage matcher sees the same input as
// creation-time reconciliation.
//
// Every checkout's own .worktreeinclude counts, resolved against that
// checkout's gitignore and unioned, the same way the CLI resolves it at
// creation (the engine's CarryOver.ts). So a
// pattern that only exists on a feature branch's worktree still shows
// up as covered here.
export const readWorktreeIncludeStatus = (
  checkouts: readonly CarryOverCheckout[],
) =>
  Effect.map(
    Effect.forEach(checkouts, (checkout) => readOneStatus(checkout.path), {
      concurrency: "unbounded",
    }),
    (perCheckout): WorktreeIncludeStatus => ({
      fileExists: perCheckout.some((status) => status.fileExists),
      matchedPaths: [...new Set(perCheckout.flatMap((s) => s.matchedPaths))],
    }),
  );

const readOneStatus = Effect.fnUntraced(function* (checkoutPath: string) {
  const exists = yield* Effect.promise(() =>
    pathExists(join(checkoutPath, WORKTREE_INCLUDE_FILE)),
  );
  if (!exists) return { fileExists: false, matchedPaths: [] as string[] };
  // A failure leaves it empty; creation-time resolution surfaces the
  // real error.
  const matchedPaths = yield* resolveMatchedPaths(checkoutPath).pipe(
    Effect.orElseSucceed((): string[] => []),
  );
  return { fileExists: true, matchedPaths };
});
