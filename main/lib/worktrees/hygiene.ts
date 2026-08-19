// Backing data for the "tidy the forest" surface: how stale a worktree
// is, whether its work already landed in the primary branch, and how
// much disk it holds.
//
// Split into two entry points on purpose. `collectProjectHygiene` is
// all-git and fast enough to block the list render; `measureWorktreeDisk`
// walks the whole directory (node_modules and all) and is fetched
// per-row so a slow disk never holds up the page.
import { unknownWorktreeError } from "@shared/errors";
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
import { createLimiter } from "../util/limit";
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
//
// The primary's own tree OID is a per-project constant, so it is
// resolved once by `primaryRefCandidates` rather than per worktree.
async function contentAlreadyIn(
  projectPath: string,
  candidate: PrimaryCandidate,
  head: string,
): Promise<boolean> {
  if (!candidate.tree) return false;
  try {
    const merged = await runLenient(projectPath, [
      "merge-tree",
      "--write-tree",
      candidate.ref,
      head,
    ]);
    const mergedTree = merged.split("\n", 1)[0]?.trim();
    return Boolean(mergedTree) && mergedTree === candidate.tree;
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
// A ref to compare against, plus the tree it points at. Null tree means
// the ref wouldn't resolve, which turns the containment probe off for it
// rather than guessing.
interface PrimaryCandidate {
  ref: string;
  tree: string | null;
}

async function primaryRefCandidates(
  projectPath: string,
  primaryRef: string | null,
  remotes: string[],
): Promise<PrimaryCandidate[]> {
  if (!primaryRef) return [];
  const split = splitRemoteRefSync(primaryRef, remotes);
  const refs = [primaryRef];
  if (split && split.branch !== primaryRef) {
    if (await localBranchExists(projectPath, split.branch)) {
      refs.push(split.branch);
    }
  }
  return Promise.all(
    refs.map(async (ref) => ({ ref, tree: await treeOf(projectPath, ref) })),
  );
}

async function treeOf(
  projectPath: string,
  ref: string,
): Promise<string | null> {
  try {
    const stdout = await run(projectPath, ["rev-parse", `${ref}^{tree}`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function hygieneFor(
  identity: WorktreeIdentity,
  projectPath: string,
  candidates: PrimaryCandidate[],
): Promise<WorktreeHygiene> {
  const lastCommitAt = await getLastCommitAt(identity.path);
  const base: WorktreeHygiene = {
    worktreeId: identity.id,
    lastCommitAt,
    uniqueCommits: 0,
    contentAlreadyInPrimary: false,
    primaryRef: candidates[0]?.ref ?? null,
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
  for (const candidate of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- candidate priority order matters
    const uniqueCommits = await countUniqueCommits(
      identity.path,
      candidate.ref,
    );
    if (uniqueCommits === 0) {
      // Fully contained already; the merge-tree probe would only confirm
      // what the commit count just proved.
      return {
        ...base,
        primaryRef: candidate.ref,
        uniqueCommits: 0,
        contentAlreadyInPrimary: true,
      };
    }
    // oxlint-disable-next-line no-await-in-loop -- candidate priority order matters
    const contained = await contentAlreadyIn(
      projectPath,
      candidate,
      identity.branch,
    );
    if (contained) {
      return {
        ...base,
        primaryRef: candidate.ref,
        uniqueCommits,
        contentAlreadyInPrimary: true,
      };
    }
    fallback ??= { ...base, primaryRef: candidate.ref, uniqueCommits };
  }
  return fallback ?? base;
}

// Probes run through a shared window because this is asked for every
// project at once: a machine with five projects would otherwise start
// forty independent git chains, `merge-tree` included, in one burst.
const gitProbes = createLimiter(6);

export async function collectProjectHygiene(
  projectId: string,
  projectPath: string,
): Promise<WorktreeHygiene[]> {
  const [identities, config, remotes] = await Promise.all([
    projectIdentities(projectId, projectPath),
    readShigomoriConfig(projectId).catch(() => null),
    listRemotes(projectPath),
  ]);
  // A repo with no resolvable default branch has nothing to compare
  // against. Reported as no candidates rather than as a failed call, so
  // the rows read "can't tell" instead of loading forever.
  const primaryRef = await resolveDefaultBranch(
    projectPath,
    config?.defaultBranch,
  ).catch(() => null);
  const candidates = await primaryRefCandidates(
    projectPath,
    primaryRef,
    remotes,
  );
  return Promise.all(
    identities.map((identity) =>
      gitProbes(() => hygieneFor(identity, projectPath, candidates)),
    ),
  );
}

// The worktree list, cached for long enough to serve one page load.
//
// The renderer asks for disk usage one worktree at a time, and each of
// those calls needs the same id-to-path lookup -- without this, opening
// the page re-runs `git worktree list` once per row on top of the once
// per project the facts already paid for.
const identityCache = ttlMapCache(10_000, (key: string) => {
  const [projectId, projectPath] = key.split("\u0000");
  return listWorktreeIdentities(projectId, projectPath);
});

function projectIdentities(
  projectId: string,
  projectPath: string,
): Promise<WorktreeIdentity[]> {
  return identityCache.get(`${projectId}\u0000${projectPath}`);
}

export async function findWorktreeForDisk(
  projectId: string,
  projectPath: string,
  worktreeId: string,
): Promise<WorktreeIdentity> {
  const identities = await projectIdentities(projectId, projectPath);
  const found = identities.find((identity) => identity.id === worktreeId);
  if (!found) throw unknownWorktreeError(worktreeId);
  return found;
}

// Three walks at a time. Each one already runs its own pool of
// directory readers, so a wider window mostly makes the first size land
// later; narrower than that and a fleet of forty crawls.
const diskWalks = createLimiter(3);

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
  const { bytes, lastActivityAt, partial } = await diskWalks(() =>
    diskCache.get(worktreePath),
  );
  return { worktreeId, bytes, lastActivityAt, partial };
}
