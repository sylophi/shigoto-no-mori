import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorMessageOf, unknownWorktreeError } from "@shared/errors";
import {
  type CommitSummary,
  isCommitHash,
  UNKNOWN_BRANCH,
  type Worktree,
} from "@shared/schemas";
import { readShelvedSet } from "../worktrees/shelved";
import { readShigomoriConfig } from "../config/project";
import { pickWorktreeName } from "../worktrees/names";
import { isManagedPath, managedBasesFor } from "../worktrees/paths";
import { createLimiter } from "@shared/util/limit";
import { run, splitZ } from "./core";
import { listRemotes, resolveDefaultBranch } from "./remotes";

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

// How many changed paths get stat'd for their mtime. Only the newest
// timestamp survives, so a worktree in the middle of a huge refactor
// doesn't need every path measured -- the cap keeps the per-worktree
// cost flat no matter how dirty the tree is.
const CHANGE_MTIME_STAT_LIMIT = 64;

interface WorkingTreeChanges {
  count: number;
  // Newest mtime across the changed paths, epoch ms. Undefined for a
  // clean worktree, and when every stat failed (an all-deletions diff).
  lastChangeAt?: number;
}

// Splits `git status --porcelain=v1 -z` into the paths it reports. The
// -z form is what makes the paths usable: without it git C-quotes
// anything with a space or a non-ASCII byte, and un-quoting that back
// into a real path is its own parser. The cost is having to consume the
// rename/copy source, which git emits as a bare extra field right after
// the entry that renamed it.
function parseStatusPaths(stdout: string): string[] {
  const fields = splitZ(stdout);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    // Every real record is "XY <path>", so anything shorter is garbage.
    if (!field || field.length < 4) continue;
    paths.push(field.slice(3));
    // Either column can be the R/C: staged renames land in the index
    // column, unstaged ones (git detects those too) in the worktree
    // column. Both emit exactly one source field, and mistaking it for a
    // record of its own both inflates the count and stats a path with
    // three bytes shorn off the front.
    if (isRenameOrCopy(field[0]) || isRenameOrCopy(field[1])) i++;
  }
  return paths;
}

function isRenameOrCopy(column: string | undefined): boolean {
  return column === "R" || column === "C";
}

async function getWorkingTreeChanges(
  worktreePath: string,
): Promise<WorkingTreeChanges> {
  try {
    // Deliberately NOT pinned to --untracked-files=normal, unlike the
    // dirty guard in overwriteFromUpstream: this runs per worktree on
    // every window focus, and `-uno` users chose that setting to make
    // exactly this scan cheap. See the comment there.
    const stdout = await run(worktreePath, ["status", "--porcelain=v1", "-z"]);
    const paths = parseStatusPaths(stdout);
    if (paths.length === 0) return { count: 0 };
    // A deleted path stats as a failure, an untracked directory stats as
    // the directory -- both are fine, we only want the newest hit.
    const times = await Promise.all(
      paths.slice(0, CHANGE_MTIME_STAT_LIMIT).map((rel) =>
        stat(join(worktreePath, rel)).then(
          (info) => info.mtimeMs,
          () => 0,
        ),
      ),
    );
    const newest = Math.max(0, ...times);
    return {
      count: paths.length,
      lastChangeAt: newest > 0 ? Math.round(newest) : undefined,
    };
  } catch {
    return { count: 0 };
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
  // A record only opens at a sentinel that starts a line. Git emits a raw
  // SOH from `%s`, but it folds a subject's newlines into spaces, so a
  // subject carrying one stays inside its own header line rather than
  // opening a record of its own. Anything else on a line belongs to the
  // open record's `--shortstat` tail.
  const records: { header: string; stats: string }[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith(LOG_SENTINEL)) {
      records.push({ header: line.slice(LOG_SENTINEL.length), stats: "" });
      continue;
    }
    const open = records.at(-1);
    if (open) open.stats += line;
  }
  const commits: CommitSummary[] = [];
  for (const { header, stats } of records) {
    const [hash, author, date, ...subjectParts] = header.split("\t");
    // Belt and braces on top of the line-anchored split: a record whose
    // first field isn't an abbreviated sha isn't a commit, so drop it
    // instead of letting it reach the renderer (and, from there, git
    // argv) as an attacker-chosen string.
    if (!hash || !isCommitHash(hash)) continue;
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
export function worktreeIdFromPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
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
  const managedBases = managedBasesFor(projectPath, config);
  const entries = parsePorcelain(stdout);
  // Which entry, if any, is the project's own checkout. Resolved once up
  // front rather than per entry, so at most one row can carry the flag:
  // every caller reads it as a singular ("the primary"), and the tidy
  // page filters rows on it.
  //
  // A bare repo has none. Every entry git lists under one is a linked
  // worktree with work in it, and this is the case that actually shows
  // up: registration folds a path to the repo's common dir, so adding a
  // project from inside a worktree of a bare repo registers the bare
  // directory. A per-entry `index === 0` fallback would then crown
  // whichever worktree git happened to list first, because the bare
  // entry is skipped before the counter moves.
  //
  // Otherwise the project path wins wherever git lists it, which is what
  // the flag means, and the first entry covers a project registered
  // deeper in the repo. Registration folds that away, so the fallback is
  // for a layout that changed under an existing registry entry.
  const checkouts = entries.filter((entry) => !entry.bare);
  const primaryPath = entries.some((entry) => entry.bare)
    ? null
    : (checkouts.find((entry) => entry.path === projectPath)?.path ??
      checkouts[0]?.path ??
      null);
  const identities: WorktreeIdentity[] = [];
  for (const entry of checkouts) {
    const branch = deriveBranch(entry);
    const isPrimary = entry.path === primaryPath;
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
      isExternal: !isManagedPath(entry.path, managedBases),
      detached: entry.detached ?? false,
    });
  }
  return identities;
}

// How many recent commits to surface on the worktree detail page. The
// teaser renders the first 3; the 4th (if present) is what tells the
// renderer there's more history to scroll, so it can show the "Show
// all" affordance without a second round trip.
const RECENT_COMMITS_COUNT = 4;

interface PrimaryRelation {
  behindPrimary: number;
  mergedIntoPrimary: boolean;
}

// Ceiling on the first-parent walk in landedOnPrimary. A worktree this
// far behind is stale enough that the answer has stopped mattering, and
// hitting the cap reports "not landed", which only leaves the row where
// it already was.
const FIRST_PARENT_SCAN_LIMIT = 2000;

// A branch can be an ancestor of the primary for two very different
// reasons: its work was merged in, or it never left the primary's own
// history -- a worktree created and then left alone while the primary
// moved on. `git branch --merged` can't tell those apart, which is why
// this walks the primary's first-parent chain instead: a branch that
// landed via a merge commit hangs off that chain, an untouched one sits
// on it. Keeping the second case out is what stops fresh, idle
// worktrees from piling into the sidebar's Merged box every time
// something else lands.
//
// A local fast-forward or rebase merge is genuinely indistinguishable
// from "never started" here -- the resulting history is identical -- so
// it reads as not landed. That errs toward leaving a row visible, and
// GitHub-hosted repos get the answer from the PR state anyway.
async function landedOnPrimary(
  worktreePath: string,
  behindPrimary: number,
  readChain: PrimaryChainReader,
): Promise<boolean> {
  if (behindPrimary > FIRST_PARENT_SCAN_LIMIT) return false;
  try {
    const [head, chain] = await Promise.all([
      run(worktreePath, ["rev-parse", "HEAD"]),
      readChain(),
    ]);
    const tip = head.trim();
    return chain !== null && tip.length > 0 && !chain.has(tip);
  } catch {
    return false;
  }
}

// The primary's first-parent chain is the same answer for every worktree
// in the project -- one object store, one ref -- so it's read once and
// shared. Lazily, because a project whose worktrees are all ahead of the
// primary never asks the question and shouldn't pay for it.
//
// Null means "couldn't read it", which callers must treat as "not
// landed": an empty set would say every HEAD is off the chain, i.e.
// everything merged.
type PrimaryChainReader = () => Promise<ReadonlySet<string> | null>;

function primaryChainReader(
  projectPath: string,
  primaryRef: string | null,
): PrimaryChainReader {
  let pending: Promise<ReadonlySet<string> | null> | null = null;
  return () => (pending ??= readPrimaryChain(projectPath, primaryRef));
}

async function readPrimaryChain(
  projectPath: string,
  primaryRef: string | null,
): Promise<ReadonlySet<string> | null> {
  if (!primaryRef) return null;
  try {
    // FIRST_PARENT_SCAN_LIMIT bounds how far behind a worktree can be
    // and still be asked about, so a chain that long covers every HEAD
    // that could be on it.
    const stdout = await run(projectPath, [
      "rev-list",
      "--first-parent",
      `-n${FIRST_PARENT_SCAN_LIMIT + 1}`,
      primaryRef,
    ]);
    return new Set(stdout.trim().split("\n").filter(Boolean));
  } catch {
    return null;
  }
}

// How the worktree sits against the project's primary branch. Both
// answers are "no relation" where the question doesn't apply (no
// primary, the primary worktree itself, detached HEAD).
async function getPrimaryRelation(
  identity: WorktreeIdentity,
  ctx: BuildContext,
): Promise<PrimaryRelation> {
  const none: PrimaryRelation = {
    behindPrimary: 0,
    mergedIntoPrimary: false,
  };
  if (!ctx.primaryRef || identity.isPrimary || identity.detached) return none;
  try {
    // `--left-right` on the symmetric difference prints "<left>\t<right>":
    // commits only on HEAD, then commits only on the primary.
    const stdout = await run(identity.path, [
      "rev-list",
      "--count",
      "--left-right",
      `HEAD...${ctx.primaryRef}`,
    ]);
    const [ahead, behind] = stdout.trim().split(/\s+/);
    const aheadOfPrimary = Number(ahead) || 0;
    const behindPrimary = Number(behind) || 0;
    // Anything HEAD still holds on its own hasn't landed yet, and a
    // branch level with the primary has nothing to have landed.
    if (aheadOfPrimary > 0 || behindPrimary === 0) {
      return { behindPrimary, mergedIntoPrimary: false };
    }
    return {
      behindPrimary,
      mergedIntoPrimary: await landedOnPrimary(
        identity.path,
        behindPrimary,
        ctx.primaryChain,
      ),
    };
  } catch {
    return none;
  }
}

// Project-level inputs every row in a list/describe/create call needs.
// Resolved once, passed by reference, so per-row work stays O(git probes
// per row) instead of O(git probes per row + project-level reads).
interface BuildContext {
  hasRemote: boolean;
  primaryRef: string | null;
  shelvedSet: ReadonlySet<string>;
  primaryChain: PrimaryChainReader;
}

async function loadBuildContext(
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
    primaryChain: primaryChainReader(projectPath, primaryRef),
  };
}

async function buildWorktree(
  identity: WorktreeIdentity,
  ctx: BuildContext,
): Promise<Worktree> {
  const [changes, recentCommits, remoteSync, primary] = await Promise.all([
    getWorkingTreeChanges(identity.path),
    listCommits(identity.path, { skip: 0, count: RECENT_COMMITS_COUNT }),
    getRemoteSync(identity.path),
    getPrimaryRelation(identity, ctx),
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
    behindPrimary: primary.behindPrimary,
    primaryRef: ctx.primaryRef ?? undefined,
    mergedIntoPrimary: primary.mergedIntoPrimary,
    changedCount: changes.count,
    lastChangeAt: changes.lastChangeAt,
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

// Each buildWorktree starts four to six git processes and the sidebar
// asks for every project at once on focus -- unbounded, that is hundreds
// of simultaneous forks. Same window as tidy's gitProbes.
const rowProbes = createLimiter(6);

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
  return Promise.all(
    ordered.map((id) => rowProbes(() => buildWorktree(id, ctx))),
  );
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
  if (!identity) throw unknownWorktreeError(worktreeId);
  return identity;
}

export async function pickAvailableWorktreeName(
  projectId: string,
  projectPath: string,
): Promise<string> {
  const existing = await listWorktreeIdentities(projectId, projectPath);
  const used = new Set(existing.map((w) => w.name.toLowerCase()));
  return pickWorktreeName(used);
}

async function removeWorktree(
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
    const msg = errorMessageOf(err);
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
