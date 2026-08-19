import { assertNever } from "@/lib/utils";
import { scoreMatch } from "@/lib/fuzzyMatch";
import {
  deriveRemoteSyncState,
  type ForestSort,
  type HygieneVerdict,
  type HygieneVerdictKind,
  type PullRequest,
  type Worktree,
  type WorktreeDiskUsage,
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
  // Whether this worktree's work has landed, and so whether removing it
  // would lose anything. The same judgement the confirm step reads, so
  // the row and the dialog can't disagree.
  verdict: HygieneVerdict;
  // Undefined until this worktree's walk lands, and never measured at
  // all until you enter tidy mode.
  disk: WorktreeDiskUsage | undefined;
}

export type ForestFacet =
  | "all"
  | "attention"
  | "dirty"
  | "pullRequest"
  | "safe";

export const FOREST_SORT_LABELS: Record<ForestSort, string> = {
  activity: "Recent activity",
  age: "Newest worktree",
  branch: "Branch name",
  size: "Size on disk",
  tidiest: "Safest to remove",
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
    case "safe":
      return entry.verdict.safe;
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

// Display order when sorting by "Safest to remove": the removable ones
// first, then increasingly attached work, with the primary checkout
// pinned last since it can never be removed.
const VERDICT_RANK: Record<HygieneVerdictKind, number> = {
  merged: 0,
  absorbed: 1,
  unknown: 2,
  active: 3,
  unpushed: 4,
  dirty: 5,
  primary: 6,
};

// An unmeasured worktree sorts as 0, so rows still counting sink to the
// bottom rather than jumping to the top of a destructive list.
const bytes = (entry: ForestEntry) => entry.disk?.bytes ?? 0;

function compareBySort(a: ForestEntry, b: ForestEntry, sort: ForestSort) {
  switch (sort) {
    case "activity":
      return newestFirst(a.lastActivityAt, b.lastActivityAt);
    case "age":
      return newestFirst(a.worktree.createdAt, b.worktree.createdAt);
    case "branch":
      return a.worktree.branch.localeCompare(b.worktree.branch);
    case "size":
      return bytes(b) - bytes(a);
    case "tidiest": {
      const rank = VERDICT_RANK[a.verdict.kind] - VERDICT_RANK[b.verdict.kind];
      return rank !== 0 ? rank : bytes(b) - bytes(a);
    }
    default:
      return assertNever(sort);
  }
}

// The rows the forest is willing to tick on your behalf. Nothing dirty,
// unmerged, detached or primary ever appears here. That is the whole
// safety guarantee of tidy mode, so it lives in one function.
export function defaultSelection(entries: readonly ForestEntry[]): Set<string> {
  return new Set(
    entries
      .filter((entry) => entry.verdict.safe)
      .map((entry) => entry.worktree.id),
  );
}

export function isSelectable(entry: ForestEntry): boolean {
  return entry.verdict.kind !== "primary";
}

export interface ForestSelectionSummary {
  selected: ForestEntry[];
  // Selected rows the forest would not have ticked itself. Non-empty
  // means the confirm step demands an extra acknowledgement.
  risky: ForestEntry[];
  // Bytes freed by the current selection, counting only measured rows.
  reclaimBytes: number;
  // True when some selected row hasn't finished measuring, so the
  // reclaim figure is a floor.
  reclaimPartial: boolean;
}

export function summarize(
  entries: readonly ForestEntry[],
  selected: ReadonlySet<string>,
): ForestSelectionSummary {
  const picked = entries.filter((entry) => selected.has(entry.worktree.id));
  return {
    selected: picked,
    risky: picked.filter((entry) => !entry.verdict.safe),
    reclaimBytes: picked.reduce(
      (sum, entry) => sum + (entry.disk?.bytes ?? 0),
      0,
    ),
    reclaimPartial: picked.some((entry) => entry.disk === undefined),
  };
}
