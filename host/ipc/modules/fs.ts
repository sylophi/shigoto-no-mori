import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { fsContract } from "@shared/ipc/modules/fs";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { isGitRepoEffect } from "@host/lib/git/core";
import { toAbsolute } from "@host/lib/util/paths";
import { hostAttempt, hostHandler } from "@host/runtime";

// Directories that virtually never contain git repos but are huge and slow to
// walk. Skipped during the scan to keep it responsive.
const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
]);

const SCAN_MAX_DEPTH = 6;

// An Effect so the caller leaving (the add-project dialog closed
// mid-scan of a home directory) stops the walk at its next directory
// rather than letting it run to the end.
function scanForGitRepos(rootPath: string): Effect.Effect<string[]> {
  const results: string[] = [];

  const walk = Effect.fnUntraced(function* (
    dir: string,
    depth: number,
  ): Effect.fn.Return<void> {
    if (depth > SCAN_MAX_DEPTH) return;
    const entries = yield* Effect.promise(() =>
      // permission denied or vanished mid-scan
      readdir(dir, { withFileTypes: true }).catch(() => null),
    );
    if (entries === null) return;

    // Outermost-only: if this dir is itself a git repo, record it and stop.
    if (entries.some((e) => e.isDirectory() && e.name === ".git")) {
      results.push(dir);
      return;
    }

    const subdirs = entries.filter(
      (e) =>
        e.isDirectory() &&
        !e.isSymbolicLink() &&
        !e.name.startsWith(".") &&
        !SCAN_SKIP_DIRS.has(e.name),
    );

    // Walk siblings in parallel. The tree fan-out at top levels is small (~10)
    // so this stays bounded.
    yield* Effect.forEach(
      subdirs,
      (entry) => walk(join(dir, entry.name), depth + 1),
      { concurrency: "unbounded", discard: true },
    );
  });

  return walk(rootPath, 0).pipe(Effect.map(() => results.toSorted()));
}

// Whether `path` holds a `.git` entry. Never fails.
const hasDotGit = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    access(join(path, ".git")).then(
      () => true,
      () => false,
    ),
  );

export const fsHandlers: Handlers<typeof fsContract, HandlerContext> = {
  listDirectory: hostHandler(({ path }) =>
    Effect.gen(function* () {
      const absolute = toAbsolute(path);
      const entries = yield* hostAttempt(() =>
        readdir(absolute, { withFileTypes: true }),
      );
      const dirs = entries.filter(
        (e) => e.isDirectory() && !e.name.startsWith("."),
      );
      // Async check in parallel beats `existsSync` per entry: same
      // logic, doesn't block the event loop on slow filesystems.
      const isGitRepoFlags = yield* Effect.forEach(
        dirs,
        (e) => hasDotGit(join(absolute, e.name)),
        { concurrency: "unbounded" },
      );
      const result = dirs
        .map((e, i) => ({ name: e.name, isGitRepo: isGitRepoFlags[i] }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
      return { path: absolute, entries: result };
    }),
  ),

  // `git rev-parse --git-dir` validates a real working repo: catches
  // missing/corrupted .git, bare repos, and linked worktrees alike.
  isGitRepo: hostHandler(({ path }) => isGitRepoEffect(toAbsolute(path))),

  scanForGitRepos: hostHandler(({ path }) => scanForGitRepos(toAbsolute(path))),
};
