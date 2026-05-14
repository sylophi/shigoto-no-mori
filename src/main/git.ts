// Thin wrappers around git CLI via child_process. Each call returns the parsed
// result; throws on non-zero exit.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import type {
  BranchList,
  CommitSummary,
  Worktree,
  WorktreeStatus,
} from "@shared/schemas";
import { pickWorktreeName } from "./animals";
import { shigomoriRoot } from "./paths";

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

interface WorktreeIdentity {
  id: string;
  projectId: string;
  // Directory basename — stable identity, separate from the branch.
  name: string;
  branch: string;
  path: string;
  isPrimary: boolean;
  isExternal: boolean;
}

export async function listWorktreeIdentities(
  projectId: string,
  projectPath: string,
): Promise<WorktreeIdentity[]> {
  const stdout = await run(projectPath, ["worktree", "list", "--porcelain"]);
  const managedPrefix = join(shigomoriRoot(), "worktrees") + sep;
  return parsePorcelain(stdout)
    .filter((e) => !e.bare)
    .map((entry, index) => {
      const branch = deriveBranch(entry);
      const isPrimary = entry.path === projectPath || index === 0;
      // Primary checkout sits at the project root, so its "name" is just
      // the project's directory basename. Managed worktrees use the picked
      // animal dirname; external ones use whatever the user named them.
      const name = basename(entry.path);
      return {
        id: `${projectId}:${name}`,
        projectId,
        name,
        branch,
        path: entry.path,
        isPrimary,
        isExternal: !entry.path.startsWith(managedPrefix),
      };
    });
}

async function buildWorktree(identity: WorktreeIdentity): Promise<Worktree> {
  const [{ ahead, behind }, dirtyCount, lastCommit] = await Promise.all([
    getAheadBehind(identity.path, identity.branch),
    getDirtyCount(identity.path),
    getLastCommit(identity.path),
  ]);
  return {
    id: identity.id,
    projectId: identity.projectId,
    name: identity.name,
    branch: identity.branch,
    path: identity.path,
    status: deriveStatus(ahead, behind, dirtyCount),
    ahead,
    behind,
    dirtyCount,
    lastCommit,
    isPrimary: identity.isPrimary,
    isExternal: identity.isExternal,
  };
}

export async function listWorktrees(
  projectId: string,
  projectPath: string,
): Promise<Worktree[]> {
  const identities = await listWorktreeIdentities(projectId, projectPath);
  // Primary first so it anchors the sidebar list as the canonical checkout.
  const ordered = identities.toSorted((a, b) =>
    a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1,
  );
  return Promise.all(ordered.map(buildWorktree));
}

export async function describeWorktree(
  identity: WorktreeIdentity,
): Promise<Worktree> {
  return buildWorktree(identity);
}

export async function findWorktreeIdentity(
  projectId: string,
  projectPath: string,
  worktreeId: string,
): Promise<WorktreeIdentity | undefined> {
  const identities = await listWorktreeIdentities(projectId, projectPath);
  return identities.find((w) => w.id === worktreeId);
}

export function deriveProjectName(path: string): string {
  return basename(path);
}

const DEFAULT_BRANCH_CANDIDATES = ["main", "master", "dev"] as const;

async function localBranchExists(
  projectPath: string,
  branch: string,
): Promise<boolean> {
  try {
    await exec(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: projectPath },
    );
    return true;
  } catch {
    return false;
  }
}

async function firstLocalBranch(projectPath: string): Promise<string | null> {
  try {
    const stdout = await run(projectPath, [
      "for-each-ref",
      "--format=%(refname:short)",
      "--count=1",
      "refs/heads/",
    ]);
    const name = stdout.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

export async function resolveDefaultBranch(
  projectPath: string,
  override?: string,
): Promise<string> {
  const trimmed = override?.trim();
  if (trimmed && (await localBranchExists(projectPath, trimmed))) {
    return trimmed;
  }
  // Override missing or pointing at a branch that no longer exists.
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    // oxlint-disable-next-line no-await-in-loop -- priority order matters; short-circuit on first hit
    if (await localBranchExists(projectPath, candidate)) return candidate;
  }
  const first = await firstLocalBranch(projectPath);
  if (first) return first;
  throw new Error(`No local branches found in ${projectPath}`);
}

// Lists branches usable as a base ref: local heads and remote-tracking refs.
// Symbolic refs like `origin/HEAD` are dropped — they alias another remote
// branch and would show up twice.
export async function listBranches(projectPath: string): Promise<BranchList> {
  const stdout = await run(projectPath, [
    "for-each-ref",
    "--format=%(refname)\t%(refname:short)\t%(symref)",
    "refs/heads/",
    "refs/remotes/",
  ]);
  const local: string[] = [];
  const remote: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [full, short, symref] = line.split("\t");
    if (!full || !short || symref) continue;
    if (full.startsWith("refs/heads/")) local.push(short);
    else if (full.startsWith("refs/remotes/")) remote.push(short);
  }
  return { local, remote };
}

export async function createWorktree(
  projectId: string,
  projectPath: string,
  branchName: string,
  base: string | undefined,
): Promise<Worktree> {
  // The worktree's directory name is decoupled from the branch: pick a
  // random animal that isn't already used by another worktree in this
  // project. Branch can rename/switch later without breaking the path.
  const existing = await listWorktreeIdentities(projectId, projectPath);
  const used = new Set(existing.map((w) => w.name));
  const worktreeName = pickWorktreeName(used);
  const projectName = basename(projectPath);
  const worktreePath = join(
    shigomoriRoot(),
    "worktrees",
    projectName,
    worktreeName,
  );

  await mkdir(dirname(worktreePath), { recursive: true });
  const args = ["worktree", "add", "-b", branchName, worktreePath];
  if (base) args.push(base);
  await run(projectPath, args);
  return buildWorktree({
    id: `${projectId}:${worktreeName}`,
    projectId,
    name: worktreeName,
    branch: branchName,
    path: worktreePath,
    isPrimary: false,
    isExternal: false,
  });
}

// Rename the branch currently checked out in a worktree.
// `git branch -m <new>` renames the current HEAD branch.
export async function renameBranch(
  worktreePath: string,
  newBranch: string,
): Promise<void> {
  await run(worktreePath, ["branch", "-m", newBranch]);
}

// Switch a worktree to a different branch. For remote-tracking refs
// like `origin/foo`, git creates the local tracking branch automatically.
export async function checkoutBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  await run(worktreePath, ["checkout", branch]);
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
