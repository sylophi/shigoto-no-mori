// Thin wrappers around git CLI via child_process. Each call returns the parsed
// result; throws on non-zero exit.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CommitSummary, Worktree, WorktreeStatus } from "@shared/schemas";

const exec = promisify(execFile);

interface RawWorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

async function run(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--git-dir"], { cwd: path });
    return true;
  } catch {
    return false;
  }
}

function parsePorcelain(stdout: string): RawWorktreeEntry[] {
  const entries: RawWorktreeEntry[] = [];
  let current: Partial<RawWorktreeEntry> = {};

  for (const line of stdout.split("\n")) {
    if (line === "") {
      if (current.path) entries.push(current as RawWorktreeEntry);
      current = {};
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current.path = value;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
  }
  if (current.path) entries.push(current as RawWorktreeEntry);
  return entries;
}

function deriveBranch(entry: RawWorktreeEntry): string {
  if (entry.branch) return entry.branch.replace(/^refs\/heads\//, "");
  if (entry.detached) return entry.head?.slice(0, 7) ?? "detached";
  return "(unknown)";
}

async function getDirtyCount(worktreePath: string): Promise<number> {
  try {
    const stdout = await run(worktreePath, ["status", "--porcelain=v1"]);
    return stdout.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

async function getAheadBehind(
  worktreePath: string,
  branch: string,
): Promise<{ ahead: number; behind: number }> {
  if (!branch || branch === "(unknown)") return { ahead: 0, behind: 0 };
  try {
    // Compare against the configured upstream (@{u}). No upstream → no counts.
    const stdout = await run(worktreePath, [
      "rev-list",
      "--left-right",
      "--count",
      `${branch}...@{u}`,
    ]);
    const [aheadStr, behindStr] = stdout.trim().split(/\s+/);
    return {
      ahead: Number.parseInt(aheadStr, 10) || 0,
      behind: Number.parseInt(behindStr, 10) || 0,
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

async function getLastCommit(
  worktreePath: string,
): Promise<CommitSummary | null> {
  try {
    // Tab-delimited; safer than newlines for parsing.
    const fmt = "%h%x09%an%x09%aI%x09%s";
    const stdout = await run(worktreePath, [
      "log",
      "-1",
      `--pretty=format:${fmt}`,
    ]);
    const [hash, author, date, ...subjectParts] = stdout.split("\t");
    if (!hash) return null;
    return {
      hash,
      author: author ?? "",
      date: date ?? "",
      subject: subjectParts.join("\t"),
    };
  } catch {
    return null;
  }
}

function deriveStatus(
  ahead: number,
  behind: number,
  dirty: number,
): WorktreeStatus {
  if (dirty > 0) return "dirty";
  if (ahead > 0 && behind > 0) return "diverged";
  if (ahead > 0) return "ahead";
  if (behind > 0) return "behind";
  return "clean";
}

export async function listWorktrees(
  projectId: string,
  projectPath: string,
): Promise<Worktree[]> {
  const stdout = await run(projectPath, ["worktree", "list", "--porcelain"]);
  const raw = parsePorcelain(stdout).filter((e) => !e.bare);

  return Promise.all(
    raw.map(async (entry, index): Promise<Worktree> => {
      const branch = deriveBranch(entry);
      const primary = entry.path === projectPath || index === 0;
      const [{ ahead, behind }, dirtyCount, lastCommit] = await Promise.all([
        getAheadBehind(entry.path, branch),
        getDirtyCount(entry.path),
        getLastCommit(entry.path),
      ]);
      return {
        id: `${projectId}:${branch}`,
        projectId,
        branch,
        path: entry.path,
        status: deriveStatus(ahead, behind, dirtyCount),
        ahead,
        behind,
        dirtyCount,
        lastCommit,
        isPrimary: primary || undefined,
      };
    }),
  );
}

export function deriveProjectName(path: string): string {
  return basename(path);
}

function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[\\/]/g, "-").replace(/[^A-Za-z0-9._-]/g, "_");
}

export function defaultWorktreePath(
  projectPath: string,
  branchName: string,
): string {
  const projectName = basename(projectPath);
  return join(
    homedir(),
    ".shigoto",
    "worktrees",
    projectName,
    sanitizeBranchForPath(branchName),
  );
}

export async function createWorktree(
  projectPath: string,
  branchName: string,
  base: string | undefined,
): Promise<string> {
  const worktreePath = defaultWorktreePath(projectPath, branchName);
  await mkdir(dirname(worktreePath), { recursive: true });
  const args = ["worktree", "add", "-b", branchName, worktreePath];
  if (base) args.push(base);
  await run(projectPath, args);
  return worktreePath;
}

export async function removeWorktree(
  projectPath: string,
  worktreePath: string,
  force: boolean,
): Promise<void> {
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  await run(projectPath, args);
}
