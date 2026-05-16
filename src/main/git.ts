// Thin wrappers around git CLI via child_process. Each call returns the parsed
// result; throws on non-zero exit.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import {
  type BranchList,
  type CommitSummary,
  UNKNOWN_BRANCH,
  type Worktree,
} from "@shared/schemas";
import { pickWorktreeName } from "./worktreeNames";
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
  return UNKNOWN_BRANCH;
}

async function getChangedCount(worktreePath: string): Promise<number> {
  try {
    const stdout = await run(worktreePath, ["status", "--porcelain=v1"]);
    return stdout.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
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

interface WorktreeIdentity {
  id: string;
  projectId: string;
  // Directory basename — stable identity, separate from the branch.
  name: string;
  branch: string;
  path: string;
  isPrimary: boolean;
  isExternal: boolean;
  detached: boolean;
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
        detached: entry.detached ?? false,
      };
    });
}

async function buildWorktree(identity: WorktreeIdentity): Promise<Worktree> {
  const [changedCount, lastCommit] = await Promise.all([
    getChangedCount(identity.path),
    getLastCommit(identity.path),
  ]);
  return {
    id: identity.id,
    projectId: identity.projectId,
    name: identity.name,
    branch: identity.branch,
    path: identity.path,
    // Remote-comparison fields are intentionally hardcoded for now; we
    // skip the `git rev-list` call entirely. Restore via git history if
    // we want ahead/behind back.
    ahead: 0,
    behind: 0,
    changedCount,
    lastCommit,
    isPrimary: identity.isPrimary,
    isExternal: identity.isExternal,
    detached: identity.detached,
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

export async function findWorktreeIdentityOrThrow(
  projectId: string,
  projectPath: string,
  worktreeId: string,
): Promise<WorktreeIdentity> {
  const identity = await findWorktreeIdentity(
    projectId,
    projectPath,
    worktreeId,
  );
  if (!identity) throw new Error(`Unknown worktree: ${worktreeId}`);
  return identity;
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

async function remoteRefExists(
  projectPath: string,
  ref: string,
): Promise<boolean> {
  try {
    await exec(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`],
      { cwd: projectPath },
    );
    return true;
  } catch {
    return false;
  }
}

async function listRemotes(projectPath: string): Promise<string[]> {
  try {
    const stdout = await run(projectPath, ["remote"]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
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
  if (trimmed) {
    // User explicitly picked it — accept whether it's local or remote.
    if (await localBranchExists(projectPath, trimmed)) return trimmed;
    if (await remoteRefExists(projectPath, trimmed)) return trimmed;
  }
  // No (valid) override. Prefer a remote-tracking ref (the source of
  // truth) over the local copy, which tends to drift. Try each remote
  // in the order `git remote` lists them — usually that's the project's
  // canonical "origin"-equivalent first.
  const remotes = await listRemotes(projectPath);
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    for (const remote of remotes) {
      // oxlint-disable-next-line no-await-in-loop -- priority order matters
      if (await remoteRefExists(projectPath, `${remote}/${candidate}`)) {
        return `${remote}/${candidate}`;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- priority order matters
    if (await localBranchExists(projectPath, candidate)) return candidate;
  }
  const first = await firstLocalBranch(projectPath);
  if (first) return first;
  throw new Error(`No local branches found in ${projectPath}`);
}

export async function pickAvailableWorktreeName(
  projectId: string,
  projectPath: string,
): Promise<string> {
  const existing = await listWorktreeIdentities(projectId, projectPath);
  const used = new Set(existing.map((w) => w.name));
  return pickWorktreeName(used);
}

// `--directory` collapses fully-ignored directories into a single
// trailing-slash entry; loose files inside partially-ignored dirs are
// listed individually. The renderer derives membership from this list to
// decide whether a filesystem entry can be carried over.
export async function listIgnoredPaths(projectPath: string): Promise<string[]> {
  const stdout = await run(projectPath, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  return stdout.split("\n").filter((line) => line.length > 0);
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

interface CreateWorktreeOptions {
  requestedWorktreeName?: string;
  branchName?: string;
  base?: string;
  checkout: boolean;
}

export async function createWorktree(
  projectId: string,
  projectPath: string,
  opts: CreateWorktreeOptions,
): Promise<Worktree> {
  const { requestedWorktreeName, branchName, base, checkout } = opts;
  // Dirname is decoupled from the branch — a random animal that isn't
  // already used by another worktree in this project. The renderer may
  // pre-pick (see ProjectsPickWorktreeName) so it can preview the path;
  // we honor that pick unless it got taken in the meantime.
  const existing = await listWorktreeIdentities(projectId, projectPath);
  const used = new Set(existing.map((w) => w.name));
  const worktreeName =
    requestedWorktreeName && !used.has(requestedWorktreeName)
      ? requestedWorktreeName
      : pickWorktreeName(used);
  const projectName = basename(projectPath);
  const worktreePath = join(
    shigomoriRoot(),
    "worktrees",
    projectName,
    worktreeName,
  );

  await mkdir(dirname(worktreePath), { recursive: true });
  if (checkout) {
    if (!base) throw new Error("Checkout mode requires a base ref");
    // No `-b`: reuse the existing branch in this new worktree. git
    // refuses if the branch is already checked out in another worktree.
    await run(projectPath, ["worktree", "add", worktreePath, base]);
  } else {
    // Quick-create: when the caller doesn't specify a branch, reuse the
    // animal dirname so the branch and worktree start aligned.
    const branch = branchName?.trim() || worktreeName;
    const args = ["worktree", "add", "-b", branch, worktreePath];
    if (base) args.push(base);
    await run(projectPath, args);
  }
  // Re-read identity from `git worktree list` so the returned worktree's
  // branch reflects what git actually settled on (e.g. checking out
  // `origin/main` creates a local `main` tracking branch).
  const fresh = await listWorktreeIdentities(projectId, projectPath);
  const identity = fresh.find((w) => w.path === worktreePath);
  if (!identity) {
    throw new Error("Worktree disappeared after creation");
  }
  return buildWorktree(identity);
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

// Force-delete a local branch. Used after worktree removal when the
// global "deleteBranchOnRemove" setting is on. `git branch -D` refuses if
// the branch is checked out elsewhere, so safety against in-use branches
// is enforced by git itself.
export async function deleteLocalBranch(
  projectPath: string,
  branch: string,
): Promise<void> {
  await run(projectPath, ["branch", "-D", branch]);
}

// Create a local branch pointing at `base` (or HEAD if omitted). When
// base is a remote-tracking ref, `--track` sets upstream automatically.
export async function createLocalBranch(
  projectPath: string,
  name: string,
  base: string | undefined,
): Promise<void> {
  const args = ["branch"];
  if (base?.includes("/")) args.push("--track");
  args.push(name);
  if (base) args.push(base);
  await run(projectPath, args);
}

// Rename any local branch (not necessarily the current one). `git branch
// -m <old> <new>` works even if `old` is checked out in a worktree —
// git updates that worktree's HEAD to the new name.
export async function renameAnyLocalBranch(
  projectPath: string,
  oldName: string,
  newName: string,
): Promise<void> {
  await run(projectPath, ["branch", "-m", oldName, newName]);
}

// Delete a local branch. `-d` is the safe variant (rejects unmerged);
// `-D` force-deletes. Either way git refuses if the branch is checked
// out in any worktree.
export async function deleteAnyLocalBranch(
  projectPath: string,
  name: string,
  force: boolean,
): Promise<void> {
  await run(projectPath, ["branch", force ? "-D" : "-d", name]);
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
