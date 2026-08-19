// Backing data for the "tidy the forest" surface: how stale a worktree
// is, whether its work already landed in the primary branch, and how
// much disk it holds.
//
// Split into two entry points on purpose. `collectProjectHygiene` is
// all-git and fast enough to block the list render; `measureWorktreeDisk`
// walks the whole directory (node_modules and all) and is fetched
// per-row so a slow disk never holds up the page.
import {
  isRealBranch,
  type WorktreeDiskUsage,
  type WorktreeHygiene,
} from "@shared/schemas";
import { readShigomoriConfig } from "../config/project";
import { run, runLenient } from "../git/core";
import {
  listRemotes,
  localBranchExists,
  resolveDefaultBranch,
  splitRemoteRefSync,
} from "../git/remotes";
import {
  listWorktreeIdentities,
  type WorktreeIdentity,
} from "../git/worktrees";
import { measureDirectory } from "../util/dirSize";
import { ttlMapCache } from "../util/ttlCache";

// Epoch ms of the worktree's HEAD commit. Null for an empty repo.
async function getLastCommitAt(worktreePath: string): Promise<number | null> {
  try {
    const stdout = await run(worktreePath, ["log", "-1", "--format=%ct"]);
    const seconds = Number(stdout.trim());
    // Floored to a whole millisecond: the IPC schema takes safe ints, so
    // a malformed %ct must not reach the boundary as a float.
    return Number.isFinite(seconds) ? Math.floor(seconds * 1000) : null;
  } catch {
    return null;
  }
}

// Commits on HEAD that `primaryRef` doesn't have.
async function countUniqueCommits(
  worktreePath: string,
  primaryRef: string,
): Promise<number> {
  try {
    const stdout = await run(worktreePath, [
      "rev-list",
      "--count",
      `${primaryRef}..HEAD`,
    ]);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

// Would merging this worktree into `primaryRef` change anything?
//
// `git merge-tree --write-tree` prints the resulting tree OID on its
// first line. If that equals the primary's own tree, the branch
// contributes no content -- which is exactly the state a squash- or
// rebase-merged branch is left in, and one that counting commits can't
// see (those branches keep commits primary never took verbatim).
//
// Conflicts exit non-zero and print a different tree, and any failure
// leaves us returning false, so every error path fails safe: the branch
// is treated as still carrying work.
async function contentAlreadyIn(
  projectPath: string,
  primaryRef: string,
  head: string,
): Promise<boolean> {
  try {
    const primaryTree = (
      await run(projectPath, ["rev-parse", `${primaryRef}^{tree}`])
    ).trim();
    if (!primaryTree) return false;
    const merged = await runLenient(projectPath, [
      "merge-tree",
      "--write-tree",
      primaryRef,
      head,
    ]);
    const mergedTree = merged.split("\n", 1)[0]?.trim();
    return Boolean(mergedTree) && mergedTree === primaryTree;
  } catch {
    return false;
  }
}

// Every ref that counts as "the primary branch" for containment.
//
// `resolveDefaultBranch` prefers the remote-tracking ref (origin/main)
// because it's the source of truth for how far behind you are. But for
// "is it safe to delete this?", work merged into the *local* main is
// equally safe -- it isn't lost, it just hasn't been pushed yet. Asking
// only about origin/main marks every locally-merged branch as unmerged,
// which is exactly backwards for a cleanup surface.
//
// Ordered canonical-first, so the ref we report is the remote one
// whenever it already contains the work.
async function primaryRefCandidates(
  projectPath: string,
  primaryRef: string,
): Promise<string[]> {
  const split = splitRemoteRefSync(primaryRef, await listRemotes(projectPath));
  if (!split || split.branch === primaryRef) return [primaryRef];
  const hasLocal = await localBranchExists(projectPath, split.branch);
  return hasLocal ? [primaryRef, split.branch] : [primaryRef];
}

async function hygieneFor(
  identity: WorktreeIdentity,
  projectPath: string,
  candidates: string[],
): Promise<WorktreeHygiene> {
  const lastCommitAt = await getLastCommitAt(identity.path);
  const base: WorktreeHygiene = {
    worktreeId: identity.id,
    lastCommitAt,
    uniqueCommits: 0,
    contentAlreadyInPrimary: false,
    primaryRef: candidates[0] ?? null,
  };
  // Nothing to compare for the primary checkout itself, a detached HEAD,
  // or when no primary ref resolved. The renderer turns each of those
  // into a "can't tell" verdict, which is never preselected.
  if (
    candidates.length === 0 ||
    identity.isPrimary ||
    identity.detached ||
    !isRealBranch(identity.branch)
  ) {
    return base;
  }

  // First candidate that already contains this work wins, and the facts
  // are then reported against *that* ref so the reason the user reads
  // names the branch the work actually landed in. If none contains it,
  // fall back to the canonical ref's numbers.
  let fallback: WorktreeHygiene | null = null;
  for (const ref of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- candidate priority order matters
    const uniqueCommits = await countUniqueCommits(identity.path, ref);
    if (uniqueCommits === 0) {
      // Fully contained already; the merge-tree probe would only confirm
      // what the commit count just proved.
      return {
        ...base,
        primaryRef: ref,
        uniqueCommits: 0,
        contentAlreadyInPrimary: true,
      };
    }
    // oxlint-disable-next-line no-await-in-loop -- candidate priority order matters
    const contained = await contentAlreadyIn(projectPath, ref, identity.branch);
    if (contained) {
      return {
        ...base,
        primaryRef: ref,
        uniqueCommits,
        contentAlreadyInPrimary: true,
      };
    }
    fallback ??= { ...base, primaryRef: ref, uniqueCommits };
  }
  return fallback ?? base;
}

export async function collectProjectHygiene(
  projectId: string,
  projectPath: string,
): Promise<WorktreeHygiene[]> {
  const [identities, config] = await Promise.all([
    listWorktreeIdentities(projectId, projectPath),
    readShigomoriConfig(projectId).catch(() => null),
  ]);
  const primaryRef = await resolveDefaultBranch(
    projectPath,
    config?.defaultBranch,
  );
  const candidates = await primaryRefCandidates(projectPath, primaryRef);
  return Promise.all(
    identities.map((identity) => hygieneFor(identity, projectPath, candidates)),
  );
}

// How many worktrees are measured at once. The tidy page is app-wide,
// so it asks for every worktree in every project in one go -- a fleet of
// dozens on a machine with a few projects. Each walk already runs its
// own bounded pool of directory readers, so letting them all start
// together just thrashes the disk and makes the first size land later
// than it would have. Three at a time keeps the queue moving visibly
// while leaving the rest of the app's git calls some IO to work with.
const DISK_WALK_CONCURRENCY = 3;

let activeWalks = 0;
const waitingWalks: Array<() => void> = [];

async function withWalkSlot<T>(walk: () => Promise<T>): Promise<T> {
  if (activeWalks >= DISK_WALK_CONCURRENCY) {
    await new Promise<void>((resolve) => waitingWalks.push(resolve));
  } else {
    activeWalks += 1;
  }
  try {
    return await walk();
  } finally {
    // Hand the slot straight to the next waiter rather than releasing
    // and re-taking it: a release would let a caller arriving in the
    // same tick jump the queue and push us over the limit.
    const next = waitingWalks.shift();
    if (next) next();
    else activeWalks -= 1;
  }
}

// Disk measurements are cached because a full walk of a big checkout
// costs real IO, and the tidy page refetches on mount and on window
// focus like every other query here. 60s is long enough to make
// navigating back instant, short enough that a freshly removed worktree
// doesn't linger in the total.
//
// Keyed by path, not id: the id is derived from the path anyway, and a
// plain path key keeps the cached walk reusable no matter who asks.
// Cache lookups sit inside the slot so a queued worktree whose walk
// landed in the meantime returns from cache instead of re-walking.
const diskCache = ttlMapCache(60_000, measureDirectory);

export async function measureWorktreeDisk(
  worktreeId: string,
  worktreePath: string,
): Promise<WorktreeDiskUsage> {
  const { bytes, lastActivityAt, partial } = await withWalkSlot(() =>
    diskCache.get(worktreePath),
  );
  return { worktreeId, bytes, lastActivityAt, partial };
}
