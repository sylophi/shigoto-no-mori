import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fsContract } from "@shared/ipc/modules/fs";
import type { Handlers } from "@shared/ipc/types";
import { isGitRepo } from "../../lib/git/core";
import { toAbsolute } from "../../lib/util/paths";

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

async function scanForGitRepos(rootPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied or vanished mid-scan
    }

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
    await Promise.all(
      subdirs.map((entry) => walk(join(dir, entry.name), depth + 1)),
    );
  }

  await walk(rootPath, 0);
  return results.toSorted();
}

export const fsHandlers: Handlers<typeof fsContract> = {
  listDirectory: async ({ path }) => {
    const absolute = toAbsolute(path);

    const entries = await readdir(absolute, { withFileTypes: true });
    const dirs = entries.filter(
      (e) => e.isDirectory() && !e.name.startsWith("."),
    );
    // Async check in parallel beats `existsSync` per entry: same logic,
    // doesn't block the event loop on slow filesystems.
    const isGitRepoFlags = await Promise.all(
      dirs.map(async (e) => {
        try {
          await access(join(absolute, e.name, ".git"));
          return true;
        } catch {
          return false;
        }
      }),
    );
    const result = dirs
      .map((e, i) => ({ name: e.name, isGitRepo: isGitRepoFlags[i] }))
      .toSorted((a, b) => a.name.localeCompare(b.name));

    return { path: absolute, entries: result };
  },

  // `git rev-parse --git-dir` validates a real working repo: catches
  // missing/corrupted .git, bare repos, and linked worktrees alike.
  isGitRepo: ({ path }) => isGitRepo(toAbsolute(path)),

  scanForGitRepos: ({ path }) => scanForGitRepos(toAbsolute(path)),

  stat: async ({ path }) => {
    try {
      const s = await stat(toAbsolute(path));
      return { exists: true, isDirectory: s.isDirectory() };
    } catch {
      return { exists: false, isDirectory: false };
    }
  },

  listEntries: async ({ path }) => {
    const absolute = toAbsolute(path);
    const raw = await readdir(absolute, { withFileTypes: true });
    // .git is special (worktree metadata); never useful as carry-over,
    // and it's where git stores its own state.
    const entries: { name: string; isDirectory: boolean }[] = [];
    for (const e of raw) {
      if (e.name === ".git") continue;
      entries.push({ name: e.name, isDirectory: e.isDirectory() });
    }
    // Folders before files, then alphabetical within each group.
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { path: absolute, entries };
  },
};
