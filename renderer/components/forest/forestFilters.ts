import { assertNever } from "@/lib/utils";
import { scoreMatch } from "@/lib/fuzzyMatch";
import {
  deriveRemoteSyncState,
  type ForestSort,
  type PullRequest,
  type Worktree,
} from "@shared/schemas";

// One worktree as the overview sees it: the raw worktree plus the two
// things the row needs that don't live on it (its PR, if the GitHub
// integration knows one) and the derived bits every filter and sort
// would otherwise recompute per comparison.
export interface ForestEntry {
  worktree: Worktree;
  pullRequest: PullRequest | undefined;
  attention: boolean;
  // Epoch ms of the newest commit on this worktree's branch, or null
  // when the branch has no commits yet. Display only.
  lastCommitAt: number | null;
  // What the recency sort runs on: the newest of the last commit and the
  // newest uncommitted edit, so a worktree you were typing in five
  // minutes ago outranks one whose last commit is newer. Same helper the
  // inbox orders by, so the two cross-project surfaces agree.
  lastActivityAt: number;
}

export type ForestFacet = "all" | "attention" | "dirty" | "pullRequest";

export const FOREST_SORT_LABELS: Record<ForestSort, string> = {
  activity: "Recent activity",
  age: "Newest worktree",
  branch: "Branch name",
};

// A worktree needs attention when it is not quietly in sync with its
// upstream: uncommitted changes, unpushed or unpulled commits, a real
// divergence, or a pull request that closed without merging while the
// branch is still checked out.
//
// Two states are deliberately NOT attention, because counting them
// would flag most of the forest and the filter would stop meaning
// anything: drift from the primary branch (`behindPrimary` -- every
// worktree older than a few commits drifts) and an unpublished branch
// (the starting state of every worktree this app creates).
export function needsAttention(
  worktree: Worktree,
  pullRequest: PullRequest | undefined,
): boolean {
  if (worktree.changedCount > 0) return true;
  if (pullRequest?.state === "CLOSED") return true;
  const state = deriveRemoteSyncState(worktree);
  switch (state.kind) {
    case "detached":
    case "synced":
    case "publish":
      return false;
    case "ahead":
    case "behind":
    case "pullAndPush":
    case "diverged":
      return true;
    default:
      return assertNever(state);
  }
}

export function matchesFacet(entry: ForestEntry, facet: ForestFacet): boolean {
  switch (facet) {
    case "all":
      return true;
    case "attention":
      return entry.attention;
    case "dirty":
      return entry.worktree.changedCount > 0;
    case "pullRequest":
      return entry.pullRequest !== undefined;
    default:
      return assertNever(facet);
  }
}

// The text filter runs over branch, folder name, and project name
// joined, so "shigo dorm" narrows to one project's worktree without
// needing a separate project picker. scoreMatch scores an empty query as
// a match, so the no-filter case needs no special case here.
export function matchesQuery(
  entry: ForestEntry,
  query: string,
  projectName: string,
): boolean {
  const haystack = `${entry.worktree.branch} ${entry.worktree.name} ${projectName}`;
  return scoreMatch(query, haystack) > 0;
}

// Newest first, with unknown timestamps sinking to the bottom rather
// than sorting as the epoch.
function newestFirst(
  a: number | null | undefined,
  b: number | null | undefined,
) {
  return (b ?? 0) - (a ?? 0);
}

export function sortEntries(
  entries: readonly ForestEntry[],
  sort: ForestSort,
): ForestEntry[] {
  return entries.toSorted((a, b) => {
    // Shelved worktrees are explicitly out of focus, so they sink to the
    // bottom of their project whatever the sort says.
    if (a.worktree.shelved !== b.worktree.shelved) {
      return a.worktree.shelved ? 1 : -1;
    }
    const primary = compareBySort(a, b, sort);
    // Branch name is the stable tiebreaker: two worktrees committed in
    // the same second shouldn't swap places between renders.
    return primary !== 0
      ? primary
      : a.worktree.branch.localeCompare(b.worktree.branch);
  });
}

function compareBySort(a: ForestEntry, b: ForestEntry, sort: ForestSort) {
  switch (sort) {
    case "activity":
      return newestFirst(a.lastActivityAt, b.lastActivityAt);
    case "age":
      return newestFirst(a.worktree.createdAt, b.worktree.createdAt);
    case "branch":
      return a.worktree.branch.localeCompare(b.worktree.branch);
    default:
      return assertNever(sort);
  }
}
