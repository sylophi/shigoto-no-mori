import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type CommitSummary,
  UNKNOWN_BRANCH,
  type Worktree,
} from "@shared/schemas";
import { comparablePath } from "../util/paths";
import { readShelvedSet } from "../worktrees/shelved";
import { readShigomoriConfig } from "../config/project";
import { pickWorktreeName } from "../worktrees/names";
import {
  isManagedPath,
  managedPrefixesFor,
  resolveWorktreeBase,
} from "../worktrees/paths";
import { run } from "./core";
import {
  fetchRemoteRef,
  listRemotes,
  remoteRefExists,
  resolveDefaultBranch,
  splitRemoteRef,
} from "./remotes";

interface RawWorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
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
    await run(worktreePath, ["merge-tree", "--write-tree", "HEAD", "@{u}"]);
    divergedClean = true;
  } catch {
    divergedClean = false;
  }
  return { ahead, behind, hasUpstream, divergedClean };
}

// `--shortstat` appends " N files changed, X insertions(+), Y deletions(-)"
// on its own line after each commit's formatted output. A SOH (\x01)
// sentinel between records keeps parsing robust against subjects that
// contain tabs or newlines.
const LOG_SENTINEL = "\x01";
const LOG_FORMAT = `${LOG_SENTINEL}%h%x09%an%x09%aI%x09%s`;

function parseLog(stdout: string): CommitSummary[] {
  const commits: CommitSummary[] = [];
  for (const chunk of stdout.split(LOG_SENTINEL)) {
    if (!chunk) continue;
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups -- string.indexOf for a single newline, not an array membership test
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
}

// Paginated branch history. `skip` walks back through `git log HEAD` so
// the renderer's infinite-scroll drawer can page in chunks; the teaser
// in the detail page passes skip=0 with a small count. Returns [] on
// any git failure (empty repo, detached state mid-rebase) so callers
// don't have to fork on error.
export async function listCommits(
  worktreePath: string,
  opts: { skip: number; count: number },
): Promise<CommitSummary[]> {
  try {
    const args = ["log", `--skip=${opts.skip}`, `-${opts.count}`];
    args.push(`--pretty=format:${LOG_FORMAT}`, "--shortstat");
    const stdout = await run(worktreePath, args);
    return parseLog(stdout);
  } catch {
    return [];
  }
}

// Worktree identity: the subset of fields the main process needs to
// route operations (path, ids, layout flags) without doing the extra
// git work to populate ahead/behind/recentCommits/etc.
export type WorktreeIdentity = Pick<
  Worktree,
  | "id"
  | "projectId"
  | "name"
  | "branch"
  | "path"
  | "isPrimary"
  | "isExternal"
  | "detached"
>;

// Derived purely from the absolute worktree path so the same path always
// produces the same id, anywhere. Paths are globally unique on a
// filesystem, so the hash is too. 12 hex chars (48 bits) leaves plenty
// of collision headroom for the handful of worktrees a project holds.
// The path is folded through comparablePath first: on Windows the same
// directory arrives as "C:\x" from node joins and "C:/x" from git
// porcelain, and both must hash to the same id.
export function worktreeIdFromPath(path: string): string {
  return createHash("sha256")
    .update(comparablePath(path))
    .digest("hex")
    .slice(0, 12);
}

export async function listWorktreeIdentities(
  projectId: string,
  projectPath: string,
): Promise<WorktreeIdentity[]> {
  const [stdout, config] = await Promise.all([
    run(projectPath, ["worktree", "list", "--porcelain"]),
    readShigomoriConfig(projectId).catch(() => null),
  ]);
  // A worktree counts as managed if it sits under any layout we know
  // about (managed root, in-project, or the configured custom path).
  // This keeps mixed states (some worktrees still in the old layout
  // after a partial migration) from mislabeling rows as external.
  const managedPrefixes = managedPrefixesFor(projectPath, config);
  const identities: WorktreeIdentity[] = [];
  let index = 0;
  for (const entry of parsePorcelain(stdout)) {
    if (entry.bare) continue;
    const branch = deriveBranch(entry);
    const isPrimary =
      comparablePath(entry.path) === comparablePath(projectPath) || index === 0;
    // Primary checkout sits at the project root, so its "name" is just
    // the project's directory basename. Managed worktrees use the picked
    // animal dirname; external ones use whatever the user named them.
    const name = basename(entry.path);
    identities.push({
      id: worktreeIdFromPath(entry.path),
      projectId,
      name,
      branch,
      path: entry.path,
      isPrimary,
      isExternal: !isManagedPath(entry.path, managedPrefixes),
      detached: entry.detached ?? false,
    });
    index++;
  }
  return identities;
}

// How many recent commits to surface on the worktree detail page. The
// teaser renders the first 3; the 4th (if present) is what tells the
// renderer there's more history to scroll, so it can show the "Show
// all" affordance without a second round trip.
const RECENT_COMMITS_COUNT = 4;

// Per-worktree count of commits the primary has but HEAD doesn't.
// Returns 0 for cases where the question doesn't apply (no primary,
// primary worktree itself, detached HEAD) so the UI can branch on > 0.
async function getBehindPrimary(
  identity: WorktreeIdentity,
  primaryRef: string | null,
): Promise<number> {
  if (!primaryRef || identity.isPrimary || identity.detached) return 0;
  try {
    const stdout = await run(identity.path, [
      "rev-list",
      "--count",
      `HEAD..${primaryRef}`,
    ]);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

// Project-level inputs every row in a list/describe/create call needs.
// Resolved once, passed by reference, so per-row work stays O(git probes
// per row) instead of O(git probes per row + project-level reads).
interface BuildContext {
  hasRemote: boolean;
  primaryRef: string | null;
  shelvedSet: ReadonlySet<string>;
}

export async function loadBuildContext(
  projectId: string,
  projectPath: string,
): Promise<BuildContext> {
  const [remotes, config] = await Promise.all([
    listRemotes(projectPath),
    readShigomoriConfig(projectId).catch(() => null),
  ]);
  const primaryRef = await resolveDefaultBranch(
    projectPath,
    config?.defaultBranch,
  ).catch(() => null);
  return {
    hasRemote: remotes.length > 0,
    primaryRef,
    shelvedSet: readShelvedSet(),
  };
}

async function buildWorktree(
  identity: WorktreeIdentity,
  ctx: BuildContext,
): Promise<Worktree> {
  const [changedCount, recentCommits, remoteSync, behindPrimary] =
    await Promise.all([
      getChangedCount(identity.path),
      listCommits(identity.path, { skip: 0, count: RECENT_COMMITS_COUNT }),
      getRemoteSync(identity.path),
      getBehindPrimary(identity, ctx.primaryRef),
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
    hasRemote: ctx.hasRemote,
    divergedClean: remoteSync.divergedClean,
    behindPrimary,
    primaryRef: ctx.primaryRef ?? undefined,
    changedCount,
    recentCommits,
    isPrimary: identity.isPrimary,
    isExternal: identity.isExternal,
    detached: identity.detached,
    shelved:
      !identity.isPrimary &&
      !identity.isExternal &&
      ctx.shelvedSet.has(identity.id),
  };
}

export async function listWorktrees(
  projectId: string,
  projectPath: string,
): Promise<Worktree[]> {
  const [identities, ctx] = await Promise.all([
    listWorktreeIdentities(projectId, projectPath),
    loadBuildContext(projectId, projectPath),
  ]);
  // Primary first so it anchors the sidebar list as the canonical checkout.
  const ordered = identities.toSorted((a, b) =>
    a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1,
  );
  return Promise.all(ordered.map((id) => buildWorktree(id, ctx)));
}

export async function describeWorktree(
  identity: WorktreeIdentity,
  projectPath: string,
): Promise<Worktree> {
  const ctx = await loadBuildContext(identity.projectId, projectPath);
  return buildWorktree(identity, ctx);
}

export async function findWorktreeIdentityOrThrow(
  projectId: string,
  projectPath: string,
  worktreeId: string,
): Promise<WorktreeIdentity> {
  const identities = await listWorktreeIdentities(projectId, projectPath);
  const identity = identities.find((w) => w.id === worktreeId);
  if (!identity) throw new Error(`Unknown worktree: ${worktreeId}`);
  return identity;
}

export function deriveProjectName(path: string): string {
  return basename(path);
}

export async function pickAvailableWorktreeName(
  projectId: string,
  projectPath: string,
): Promise<string> {
  const existing = await listWorktreeIdentities(projectId, projectPath);
  const used = new Set(existing.map((w) => w.name));
  return pickWorktreeName(used);
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
  // already used by another worktree in this project. When the caller
  // supplies a name we treat it as a user-chosen destination and fail
  // loudly on collision; only the unset case falls back to an animal
  // pick (the renderer's pre-pick also flows through here).
  const existing = await listWorktreeIdentities(projectId, projectPath);
  const used = new Set(existing.map((w) => w.name));
  if (requestedWorktreeName && used.has(requestedWorktreeName)) {
    throw new Error(
      `A worktree folder named "${requestedWorktreeName}" already exists in this project.`,
    );
  }
  const worktreeName = requestedWorktreeName || pickWorktreeName(used);
  const config = await readShigomoriConfig(projectId).catch(() => null);
  const worktreePath = join(
    resolveWorktreeBase(projectPath, config),
    worktreeName,
  );

  // Refresh the remote-tracking ref the new worktree will sit on.
  // Without this, refs/remotes/<base> is whatever the last fetch left
  // behind -- which often matches local main and looks like the
  // worktree silently used the local branch as its base.
  if (base && (await remoteRefExists(projectPath, base))) {
    const split = await splitRemoteRef(projectPath, base);
    if (split) {
      await fetchRemoteRef(projectPath, split.remote, split.branch).catch(
        () => undefined,
      );
    }
  }

  await mkdir(dirname(worktreePath), { recursive: true });
  if (checkout) {
    if (!base) throw new Error("Checkout mode requires a base ref");
    // No `-b`: reuse the existing branch in this new worktree. git
    // refuses if the branch is already checked out in another worktree.
    // `--` keeps a base ref from being parsed as flags.
    await run(projectPath, ["worktree", "add", "--", worktreePath, base]);
  } else {
    // Quick-create: when the caller doesn't specify a branch, reuse the
    // animal dirname so the branch and worktree start aligned.
    const branch = branchName?.trim() || worktreeName;
    const args = ["worktree", "add", "-b", branch, "--", worktreePath];
    if (base) args.push(base);
    await run(projectPath, args);
  }
  // Re-read identity from `git worktree list` so the returned worktree's
  // branch reflects what git actually settled on (e.g. checking out
  // `origin/main` creates a local `main` tracking branch).
  const [fresh, ctx] = await Promise.all([
    listWorktreeIdentities(projectId, projectPath),
    loadBuildContext(projectId, projectPath),
  ]);
  // comparablePath: git porcelain reports forward-slash paths on
  // Windows while worktreePath was built with node joins.
  const identity = fresh.find(
    (w) => comparablePath(w.path) === comparablePath(worktreePath),
  );
  if (!identity) {
    throw new Error("Worktree disappeared after creation");
  }
  return buildWorktree(identity, ctx);
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

// Force-removes a worktree, falling back to a manual wipe when git's
// recursive rmdir fails with ENOTEMPTY (untracked content git couldn't
// sweep -- caches, files held open). We don't retry `git worktree
// remove` after fs.rm because once the dir is gone, remove errors out
// on "not on disk". Other failures (corrupt repo, EACCES) rethrow so
// real bugs stay visible.
export async function removeWorktreeForce(
  projectPath: string,
  worktreePath: string,
): Promise<void> {
  try {
    await removeWorktree(projectPath, worktreePath, true);
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Directory not empty|ENOTEMPTY/i.test(msg)) {
      throw err;
    }
    console.warn(`[worktrees] force-wipe fallback: ${msg}`);
  }
  await rm(worktreePath, { recursive: true, force: true });
  await pruneStaleWorktrees(projectPath);
}

// Drops admin entries under $GIT_DIR/worktrees whose checkout dir is
// gone. Used after a fallback fs.rm and after the nuke-everything root
// wipe to keep `git worktree list` honest.
export async function pruneStaleWorktrees(projectPath: string): Promise<void> {
  await run(projectPath, ["worktree", "prune"]);
}

// Moves a worktree's checkout to a new directory. `git worktree move`
// preserves the working tree, index, and untracked files; the absolute
// carry-over symlinks stay valid because their targets don't change. Git
// refuses if the worktree is locked, dirty in a way that conflicts with
// the move, or the destination already exists.
export async function relocateWorktree(
  projectPath: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  await mkdir(dirname(newPath), { recursive: true });
  await run(projectPath, ["worktree", "move", oldPath, newPath]);
}
