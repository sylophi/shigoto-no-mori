// Thin wrappers around git CLI via child_process. Each call returns the parsed
// result; throws on non-zero exit.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

const execFileP = promisify(execFile);

// Single chokepoint for every git invocation so we can timing-log them. The
// global activity spinner was removed in favor of these console traces.
async function exec(
  args: string[],
  options: { cwd: string; maxBuffer?: number },
): Promise<{ stdout: string }> {
  const start = performance.now();
  try {
    const result = await execFileP("git", args, options);
    const elapsed = Math.round(performance.now() - start);
    console.log(`[git] ${args.join(" ")} (${elapsed}ms)`);
    return { stdout: result.stdout };
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    console.warn(`[git] ${args.join(" ")} FAIL (${elapsed}ms)`);
    throw err;
  }
}

interface RawWorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

async function run(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec(args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

// Like `run`, but tolerates non-zero exit (e.g. `git diff --no-index`,
// which exits 1 whenever there's a diff to print). Returns whatever
// stdout was produced before exit, falling back to empty.
async function runLenient(cwd: string, args: string[]): Promise<string> {
  try {
    return await run(cwd, args);
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? "";
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await exec(["rev-parse", "--git-dir"], { cwd: path });
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

interface RemoteSync {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  divergedClean: boolean;
}

// Probes how the worktree's HEAD relates to its upstream. Failure of the
// rev-list call is taken as "no upstream" -- either the branch was never
// pushed, or HEAD is detached. `divergedClean` runs a `merge-tree`
// probe only when both sides have unique commits; it tells the UI
// whether a whole-tree merge would land cleanly. The action behind
// the "Pull and push" button tries `rebase` first and falls back to
// `merge` on a per-commit conflict, so this probe gates that fallback.
async function getRemoteSync(worktreePath: string): Promise<RemoteSync> {
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  try {
    const stdout = await run(worktreePath, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{u}",
    ]);
    const [a, b] = stdout.trim().split(/\s+/);
    ahead = Number(a) || 0;
    behind = Number(b) || 0;
    hasUpstream = true;
  } catch {
    return { ahead: 0, behind: 0, hasUpstream: false, divergedClean: false };
  }
  if (ahead === 0 || behind === 0) {
    return { ahead, behind, hasUpstream, divergedClean: false };
  }
  // Diverged: ask git whether a merge would land without conflicts.
  // `merge-tree --write-tree` exits 0 on a clean merge and non-zero
  // when conflicts would arise (or on git < 2.38, where we treat the
  // unknown as "not clean" -- safer default).
  let divergedClean = false;
  try {
    await exec(["merge-tree", "--write-tree", "HEAD", "@{u}"], {
      cwd: worktreePath,
    });
    divergedClean = true;
  } catch {
    divergedClean = false;
  }
  return { ahead, behind, hasUpstream, divergedClean };
}

// Unified patch of every uncommitted change in the worktree. Combines
// `git diff HEAD` (covers staged + unstaged tracked edits) with a
// /dev/null diff per untracked file so additions render alongside
// modifications in @pierre/diffs. `runLenient` swallows the non-zero
// exits `git diff --no-index` always emits when there's a diff.
export async function getWorktreeDiff(worktreePath: string): Promise<string> {
  const tracked = await runLenient(worktreePath, [
    "diff",
    "HEAD",
    "--no-color",
  ]);
  const lsOutput = await runLenient(worktreePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const untracked = lsOutput.split("\0").filter((s) => s.length > 0);
  const additions = await Promise.all(
    untracked.map((file) =>
      runLenient(worktreePath, [
        "diff",
        "--no-index",
        "--no-color",
        "/dev/null",
        file,
      ]),
    ),
  );
  return [tracked, ...additions].filter((s) => s.length > 0).join("");
}

async function getRecentCommits(
  worktreePath: string,
  count: number,
): Promise<CommitSummary[]> {
  try {
    // `--shortstat` appends " N files changed, X insertions(+), Y deletions(-)"
    // on its own line after each commit's formatted output. A SOH (\x01)
    // sentinel between records keeps parsing robust against subjects that
    // contain tabs or newlines.
    const SENTINEL = "\x01";
    const fmt = `${SENTINEL}%h%x09%an%x09%aI%x09%s`;
    const stdout = await run(worktreePath, [
      "log",
      `-${count}`,
      `--pretty=format:${fmt}`,
      "--shortstat",
    ]);
    const commits: CommitSummary[] = [];
    for (const chunk of stdout.split(SENTINEL)) {
      if (!chunk) continue;
      const newlineAt = chunk.indexOf("\n");
      const header = newlineAt === -1 ? chunk : chunk.slice(0, newlineAt);
      const stats = newlineAt === -1 ? "" : chunk.slice(newlineAt + 1);
      const [hash, author, date, ...subjectParts] = header.split("\t");
      if (!hash) continue;
      const insMatch = /(\d+) insertions?\(\+\)/.exec(stats);
      const delMatch = /(\d+) deletions?\(-\)/.exec(stats);
      commits.push({
        hash,
        author: author ?? "",
        date: date ?? "",
        subject: subjectParts.join("\t"),
        additions: insMatch ? Number(insMatch[1]) : 0,
        deletions: delMatch ? Number(delMatch[1]) : 0,
      });
    }
    return commits;
  } catch {
    return [];
  }
}

// Unified patch of a single commit, with the commit metadata stripped
// (`--format=`) so the output feeds straight into @pierre/diffs'
// `parsePatchFiles`. Returns empty for commits without diffs (e.g. an
// unconfigured merge commit).
export async function getCommitDiff(
  worktreePath: string,
  hash: string,
): Promise<string> {
  return runLenient(worktreePath, ["show", "--format=", "--no-color", hash]);
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

// Derived purely from the absolute worktree path so the same path always
// produces the same id, anywhere. Paths are globally unique on a
// filesystem, so the hash is too. 12 hex chars (48 bits) leaves plenty
// of collision headroom for the handful of worktrees a project holds.
export function worktreeIdFromPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
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
        id: worktreeIdFromPath(entry.path),
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

// How many recent commits to surface on the worktree detail page. Kept
// small so the IPC payload stays tight; revisit if the UI grows a
// "full history" view.
const RECENT_COMMITS_COUNT = 3;

async function buildWorktree(
  identity: WorktreeIdentity,
  hasRemote: boolean,
): Promise<Worktree> {
  const [changedCount, recentCommits, remoteSync] = await Promise.all([
    getChangedCount(identity.path),
    getRecentCommits(identity.path, RECENT_COMMITS_COUNT),
    getRemoteSync(identity.path),
  ]);
  return {
    id: identity.id,
    projectId: identity.projectId,
    name: identity.name,
    branch: identity.branch,
    path: identity.path,
    ahead: remoteSync.ahead,
    behind: remoteSync.behind,
    hasUpstream: remoteSync.hasUpstream,
    hasRemote,
    divergedClean: remoteSync.divergedClean,
    changedCount,
    recentCommits,
    isPrimary: identity.isPrimary,
    isExternal: identity.isExternal,
    detached: identity.detached,
  };
}

export async function listWorktrees(
  projectId: string,
  projectPath: string,
): Promise<Worktree[]> {
  const [identities, remotes] = await Promise.all([
    listWorktreeIdentities(projectId, projectPath),
    listRemotes(projectPath),
  ]);
  const hasRemote = remotes.length > 0;
  // Primary first so it anchors the sidebar list as the canonical checkout.
  const ordered = identities.toSorted((a, b) =>
    a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1,
  );
  return Promise.all(ordered.map((id) => buildWorktree(id, hasRemote)));
}

export async function describeWorktree(
  identity: WorktreeIdentity,
  projectPath: string,
): Promise<Worktree> {
  const remotes = await listRemotes(projectPath);
  return buildWorktree(identity, remotes.length > 0);
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
    await exec(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: projectPath,
    });
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
    await exec(["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`], {
      cwd: projectPath,
    });
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

// Coalesces overlapping callers onto a single in-flight fetch so the
// focus-driven sweep, the periodic refresh, and a pre-action call from
// `createWorktree` can't dogpile a slow remote.
const fetchInflight = new Map<string, Promise<void>>();

export async function fetchAllRemotes(projectPath: string): Promise<void> {
  const existing = fetchInflight.get(projectPath);
  if (existing) return existing;
  const p = run(projectPath, ["fetch", "--all", "--quiet", "--prune"])
    .then(() => undefined)
    .finally(() => {
      fetchInflight.delete(projectPath);
    });
  fetchInflight.set(projectPath, p);
  return p;
}

// Single-string snapshot of every remote-tracking ref + its SHA. Compared
// before/after a fetch to skip the broadcast when nothing actually moved.
export async function snapshotRemoteRefs(projectPath: string): Promise<string> {
  return run(projectPath, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/remotes/",
  ]);
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

  // Refresh remote-tracking refs so the new worktree starts at the actual
  // upstream tip. Without this, `refs/remotes/origin/main` is whatever the
  // last fetch left behind -- which often matches local `main` and looks
  // like the worktree silently used the local branch as its base.
  if (base && (await remoteRefExists(projectPath, base))) {
    await fetchAllRemotes(projectPath).catch(() => undefined);
  }

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
  const [fresh, remotes] = await Promise.all([
    listWorktreeIdentities(projectId, projectPath),
    listRemotes(projectPath),
  ]);
  const identity = fresh.find((w) => w.path === worktreePath);
  if (!identity) {
    throw new Error("Worktree disappeared after creation");
  }
  return buildWorktree(identity, remotes.length > 0);
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

// Remote sync mutations. Each operates on a single worktree's checkout
// and lets `git` surface any failure as a non-zero exit (which `run`
// turns into a thrown Error -- the IPC layer relays the message verbatim
// into the renderer's toast).

export async function pushFastForward(worktreePath: string): Promise<void> {
  await run(worktreePath, ["push"]);
}

export async function pullFastForward(worktreePath: string): Promise<void> {
  await run(worktreePath, ["pull", "--ff-only"]);
}

export async function pushForceWithLease(worktreePath: string): Promise<void> {
  await run(worktreePath, ["push", "--force-with-lease"]);
}

// "Overwrite": throw away the local divergence and snap to the upstream.
// Fetch first so `@{u}` reflects the current remote tip.
export async function overwriteFromUpstream(
  worktreePath: string,
): Promise<void> {
  await run(worktreePath, ["fetch"]);
  await run(worktreePath, ["reset", "--hard", "@{u}"]);
}

// Publish: push the current branch to the first configured remote with
// upstream tracking. `HEAD` resolves to whatever's checked out, and `-u`
// wires up `branch.<name>.{remote,merge}` so subsequent pulls/pushes
// don't need an explicit remote.
export async function publishCurrentBranch(
  worktreePath: string,
  projectPath: string,
): Promise<void> {
  const remotes = await listRemotes(projectPath);
  const first = remotes[0];
  if (!first) throw new Error("No git remote configured");
  await run(worktreePath, ["push", "-u", first, "HEAD"]);
}

// Combined resolution for the "diverged but mergeable" state. Tries
// rebase first for linear history; if a per-commit conflict strands the
// rebase, aborts and falls back to a whole-tree merge -- which the
// `merge-tree --write-tree` probe (gating this state) already validated
// as clean. If the fallback merge unexpectedly conflicts too (probe was
// wrong), aborts the merge before propagating so the worktree isn't
// left in a half-merged state.
export async function pullRebaseOrMergeAndPush(
  worktreePath: string,
): Promise<void> {
  await run(worktreePath, ["fetch"]);
  try {
    await run(worktreePath, ["rebase", "@{u}"]);
  } catch {
    // Rebase hit a per-commit conflict. Restore the pre-rebase HEAD and
    // try a whole-tree merge instead.
    await runLenient(worktreePath, ["rebase", "--abort"]);
    try {
      await run(worktreePath, ["merge", "@{u}"]);
    } catch (err) {
      await runLenient(worktreePath, ["merge", "--abort"]);
      throw err;
    }
  }
  await run(worktreePath, ["push"]);
}
