// Thin wrappers around git CLI via child_process. Each call returns the parsed
// result; throws on non-zero exit.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import type { Worktree, WorktreeStatus } from "@shared/schemas";

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

export async function listWorktrees(
  projectId: string,
  projectPath: string,
): Promise<Worktree[]> {
  const stdout = await run(projectPath, ["worktree", "list", "--porcelain"]);
  const raw = parsePorcelain(stdout).filter((e) => !e.bare);

  return raw.map((entry, index): Worktree => {
    const branch = deriveBranch(entry);
    const primary = entry.path === projectPath || index === 0;
    return {
      id: `${projectId}:${branch}`,
      projectId,
      branch,
      path: entry.path,
      status: "clean" satisfies WorktreeStatus,
      ahead: 0,
      behind: 0,
      dirtyCount: 0,
      lastCommit: null,
      isPrimary: primary || undefined,
    };
  });
}

export function deriveProjectName(path: string): string {
  return basename(path);
}
