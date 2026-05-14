import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  type DirectoryListing,
  IsGitRepoPayloadSchema,
  ListDirectoryPayloadSchema,
  ScanForGitReposPayloadSchema,
} from "@shared/schemas";
import { isGitRepo } from "../git";
import { expandHome } from "../paths";

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

export function registerFsHandlers(): void {
  ipcMain.handle(
    CHANNELS.FsListDirectory,
    async (_event, rawPayload: unknown): Promise<DirectoryListing> => {
      const { path } = ListDirectoryPayloadSchema.parse(rawPayload);

      const expanded = expandHome(path);
      const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);

      const entries = await readdir(absolute, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          isGitRepo: existsSync(join(absolute, e.name, ".git")),
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name));

      return { path: absolute, entries: dirs };
    },
  );

  ipcMain.handle(
    CHANNELS.FsIsGitRepo,
    async (_event, rawPayload: unknown): Promise<boolean> => {
      const { path } = IsGitRepoPayloadSchema.parse(rawPayload);
      const expanded = expandHome(path);
      const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
      // `git rev-parse --git-dir` validates a real working repo: catches
      // missing/corrupted .git, bare repos, and linked worktrees alike.
      return isGitRepo(absolute);
    },
  );

  ipcMain.handle(
    CHANNELS.FsScanForGitRepos,
    async (_event, rawPayload: unknown): Promise<string[]> => {
      const { path } = ScanForGitReposPayloadSchema.parse(rawPayload);
      const absolute = isAbsolute(expandHome(path))
        ? expandHome(path)
        : resolve(expandHome(path));
      return scanForGitRepos(absolute);
    },
  );
}
