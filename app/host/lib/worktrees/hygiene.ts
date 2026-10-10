// Backing data for the "tidy the forest" surface: how stale a worktree
// is, whether its work already landed in the primary branch, and how
// much disk it holds.
//
// Split into two entry points on purpose. `collectProjectHygiene` is
// all-git and fast enough to block the list render; `measureWorktreeDisk`
// walks the whole directory (node_modules and all) and is fetched
// per-row so a slow disk never holds up the page.
import { UnknownWorktreeError } from "@shigomori/contracts/errors";
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import {
  isRealBranch,
  type WorktreeHygiene,
} from "@shigomori/contracts/schemas";
import { run, runLenient } from "../git/core";
import { treeOf } from "../git/refs";
import {
  listRemotes,
  localBranchExists,
  splitRemoteRefSync,
} from "../git/remotes";
import type { WorktreeIdentity } from "../git/worktrees";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Ops from "../engineOps";
import { ttlEffectCache } from "../util/ttlCache";

interface HeadCommit {
  // Epoch ms of the worktree's HEAD commit.
  at: number | null;
  // Abbreviated hash, matching how the worktree list reports commits so
  // the two can be compared.
  hash: string | null;
}

// The commit HEAD points at. Both fields null for an empty repo.
const getHeadCommit = (worktreePath: string) =>
  run(worktreePath, ["log", "-1", "--format=%ct%n%h"]).pipe(
    Effect.map((stdout): HeadCommit => {
      const [seconds, hash] = stdout.trim().split("\n");
      const at = Number(seconds);
      return {
        // Floored to a whole millisecond: the IPC schema takes safe ints,
        // so a malformed %ct must not reach the boundary as a float.
        at: Number.isFinite(at) ? Math.floor(at * 1000) : null,
        hash: hash?.trim() || null,
      };
    }),
    Effect.orElseSucceed((): HeadCommit => ({ at: null, hash: null })),
  );

// Commits on HEAD that `primaryRef` doesn't have, or null when the
// count couldn't be taken.
//
// The null matters more than the number: 0 is what makes the page tick a
// row for deletion, and a prunable worktree (directory deleted out from
// under git), an unreadable ref or a corrupt repo all fail here. Folding
// those into 0 would preselect them as "every commit is already in
// main", which is the one mistake this surface must not make. Unparsable
// output is treated the same way, failing safe like `contentAlreadyIn`.
const countUniqueCommits = (worktreePath: string, primaryRef: string) =>
  run(worktreePath, ["rev-list", "--count", `${primaryRef}..HEAD`]).pipe(
    Effect.map((stdout) => {
      const count = Number(stdout.trim());
      return Number.isInteger(count) && count >= 0 ? count : null;
    }),
    Effect.orElseSucceed(() => null),
  );

// Does this worktree hold untracked files?
//
// `git status` honours status.showUntrackedFiles, so a user running
// `-uno` gets changedCount === 0 for a tree full of new files. This asks
// the question that setting suppresses, and is only asked for the rows
// that would otherwise be ticked. `--exclude-standard` keeps it off
// ignored paths, so node_modules costs nothing.
const hasUntrackedFiles = (worktreePath: string) =>
  run(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]).pipe(
    Effect.map((stdout) => stdout.length > 0),
    // Unreadable cuts the same way as dirty: assume there is something
    // to lose.
    Effect.orElseSucceed(() => true),
  );

// Would merging this worktree into `primaryRef` change anything?
//
// `git merge-tree --write-tree` prints the resulting tree OID on its
// first line. If that equals the primary's own tree, the branch
// contributes no content, which is exactly the state a squash- or
// rebase-merged branch is left in, and one that counting commits can't
// see (those branches keep commits primary never took verbatim).
//
// Conflicts exit non-zero and print a different tree, and any failure
// leaves us returning false, so every error path fails safe: the branch
// is treated as still carrying work.
//
// The primary's own tree OID is a per-project constant, so it is
// resolved once by `primaryRefCandidates` rather than per worktree.
const contentAlreadyIn = (
  projectPath: string,
  candidate: PrimaryCandidate,
  head: string,
) =>
  candidate.tree === null
    ? Effect.succeed(false)
    : runLenient(projectPath, [
        "merge-tree",
        "--write-tree",
        candidate.ref,
        head,
      ]).pipe(
        Effect.map((merged) => {
          const mergedTree = merged.split("\n", 1)[0]?.trim();
          return Boolean(mergedTree) && mergedTree === candidate.tree;
        }),
        Effect.orElseSucceed(() => false),
      );

// Every ref that counts as "the primary branch" for containment.
//
// The primary ref prefers the remote-tracking ref (origin/main)
// because it's the source of truth for how far behind you are. But for
// "is it safe to delete this?", work merged into the *local* main is
// equally safe. It isn't lost, it just hasn't been pushed yet. Asking
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

const primaryRefCandidates = Effect.fnUntraced(function* (
  projectPath: string,
  primaryRef: string | null,
  remotes: string[],
) {
  if (!primaryRef) return [];
  const split = splitRemoteRefSync(primaryRef, remotes);
  const refs = [primaryRef];
  if (split && split.branch !== primaryRef) {
    if (yield* localBranchExists(projectPath, split.branch)) {
      refs.push(split.branch);
    }
  }
  return yield* Effect.forEach(
    refs,
    (ref) =>
      treeOf(projectPath, ref).pipe(
        Effect.orElseSucceed(() => null),
        Effect.map((tree): PrimaryCandidate => ({ ref, tree })),
      ),
    { concurrency: "unbounded" },
  );
});

// The untracked scan is worth a git call only where the answer changes
// something, and that is exactly here: a worktree reported as contained
// is one the page ticks on its own, so this is the last chance to notice
// files that exist nowhere else.
const contained = (worktreePath: string, facts: WorktreeHygiene) =>
  Effect.map(
    hasUntrackedFiles(worktreePath),
    (untracked): WorktreeHygiene => ({ ...facts, untracked }),
  );

const hygieneFor = Effect.fnUntraced(function* (
  identity: WorktreeIdentity,
  projectPath: string,
  candidates: PrimaryCandidate[],
  primaryBranch: string | null,
) {
  const head = yield* getHeadCommit(identity.path);
  const base: WorktreeHygiene = {
    worktreeId: identity.id,
    lastCommitAt: head.at,
    headHash: head.hash,
    uniqueCommits: null,
    contentAlreadyInPrimary: false,
    primaryRef: candidates[0]?.ref ?? null,
    holdsPrimaryBranch:
      !identity.detached &&
      primaryBranch !== null &&
      identity.branch === primaryBranch,
    untracked: false,
  };
  // Nothing to compare for the primary checkout itself, a detached HEAD,
  // or when no primary ref resolved. The renderer turns each of those
  // into a "can't tell" verdict, which is never preselected.
  //
  // The primary takes this arm on purpose, and it is not what keeps it
  // off the tidy page. That list drops primaries before they become
  // rows. It is what keeps every other caller safe: facts that compare
  // to nothing can't derive the merged verdict that ticks a row.
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
  // One candidate after another: their priority order matters.
  for (const candidate of candidates) {
    const uniqueCommits = yield* countUniqueCommits(
      identity.path,
      candidate.ref,
    );
    // A failed count says nothing about this ref, so move on rather than
    // report a number that isn't one.
    if (uniqueCommits === null) continue;
    if (uniqueCommits === 0) {
      // Fully contained already. The merge-tree probe would only
      // confirm what the commit count just proved.
      return yield* contained(identity.path, {
        ...base,
        primaryRef: candidate.ref,
        uniqueCommits: 0,
        contentAlreadyInPrimary: true,
      });
    }
    const alreadyIn = yield* contentAlreadyIn(
      projectPath,
      candidate,
      identity.branch,
    );
    if (alreadyIn) {
      return yield* contained(identity.path, {
        ...base,
        primaryRef: candidate.ref,
        uniqueCommits,
        contentAlreadyInPrimary: true,
      });
    }
    fallback ??= { ...base, primaryRef: candidate.ref, uniqueCommits };
  }

  return fallback ?? base;
});

// Probes run through a shared window because this is asked for every
// project at once: a machine with five projects would otherwise start
// forty independent git chains, `merge-tree` included, in one burst.
const gitProbes = Semaphore.makeUnsafe(6);

export const collectProjectHygiene = Effect.fnUntraced(function* (
  projectId: string,
  projectPath: string,
) {
  // A repo with no resolvable default branch has nothing to compare
  // against. Reported as no candidates rather than as a failed call, so
  // the rows read "can't tell" instead of loading forever. The local
  // branch name behind the primary ref ("main" for "origin/main") is so
  // a linked worktree that has it checked out can be recognised and kept
  // off the tick list.
  const [identities, remotes] = yield* Effect.all(
    [identityCache.get(projectId), listRemotes(projectPath)],
    { concurrency: 2 },
  );
  // Resolved once per project by the engine and carried on every
  // identity.
  const primaryRef = identities[0]?.primaryRef ?? null;
  const primaryBranch = identities[0]?.primaryBranch ?? null;
  const candidates = yield* primaryRefCandidates(
    projectPath,
    primaryRef,
    remotes,
  );
  return yield* Effect.forEach(
    identities,
    (identity) =>
      hygieneFor(identity, projectPath, candidates, primaryBranch).pipe(
        gitProbes.withPermits(1),
      ),
    { concurrency: "unbounded" },
  );
});

// The worktree identities (with the project's primary ref), cached for
// long enough to serve one page load.
//
// The renderer asks for disk usage one worktree at a time, and each of
// those calls needs the same id-to-path lookup. Without this, opening
// the page re-runs the engine's identity list once per row on top of
// the once per project the facts already paid for. The renderer asks
// for every worktree's disk usage at once, so the whole burst arrives
// before the first lookup has resolved: the cache coalescing those
// misses is what makes it one identity list per project rather than
// one per row.
const identityCache = ttlEffectCache(10_000, (projectId: string) =>
  Ops.listWorktreeIdentities({ projectId }, { primaryRef: true }),
);

export const findWorktreeForDisk = Effect.fnUntraced(function* (
  projectId: string,
  worktreeId: string,
) {
  const identities = yield* identityCache.get(projectId);
  const found = identities.find((identity) => identity.id === worktreeId);
  if (!found) return yield* new UnknownWorktreeError({ worktreeId });
  return found;
});

// Three walks at a time. Each one is an `sm disk-usage` child running
// its own pool of directory readers, so a wider window mostly makes the
// first size land later. Any narrower and a fleet of forty crawls.
const diskWalks = Semaphore.makeUnsafe(3);

// Disk measurements are cached because a full walk of a big checkout
// costs real IO, and the tidy page refetches on mount and on window
// focus like every other query here. 60s is long enough to make
// navigating back instant, short enough that a freshly removed worktree
// doesn't linger in the total.
//
// Keyed by path plus whatever was carved out of it, not by id: the id is
// derived from the path anyway, and folding the carve-outs into the key
// keeps a walk from being reused after a nested worktree appeared or
// went away. Cache lookups sit inside the slot so a queued worktree
// whose walk landed in the meantime returns from cache instead of
// re-walking.
const diskCache = ttlEffectCache(60_000, (key: string) => {
  // split always answers at least one part, so the default never applies.
  const [root = key, ...excluded] = key.split("\u0000");
  return Ops.diskUsage(root, excluded);
});

export const measureWorktreeDisk = Effect.fnUntraced(function* (
  projectId: string,
  worktree: WorktreeIdentity,
) {
  const worktreePath = worktree.path;
  // Under the in-project layout a project's worktrees live inside its
  // primary checkout. Each one is measured as its own row, so the
  // enclosing walk steps over them rather than counting them twice.
  const identities = yield* identityCache.get(projectId);
  const nested = identities
    .map((identity) => identity.path)
    .filter(
      (path) => path !== worktreePath && isSameOrInside(path, worktreePath),
    )
    .toSorted();
  const usage = yield* diskCache
    .get([worktreePath, ...nested].join("\u0000"))
    .pipe(diskWalks.withPermits(1));
  return { worktreeId: worktree.id, ...usage };
});
