import {
  deriveHygieneVerdict,
  type HygieneVerdict,
  type HygieneVerdictKind,
  type Worktree,
  type WorktreeDiskUsage,
  type WorktreeHygiene,
} from "@shared/schemas";

// One row on the tidy page: the worktree plus everything we judged
// about it. `disk` is undefined until that worktree's walk lands.
export interface TidyEntry {
  worktree: Worktree;
  verdict: HygieneVerdict;
  hygiene: WorktreeHygiene | undefined;
  disk: WorktreeDiskUsage | undefined;
  // How old the *work* is, and what the Age sort uses.
  //
  // This is the commit date, not the newest file mtime: `git worktree
  // add` stamps every checked-out file with the current time, so a
  // worktree branched from year-old work would otherwise report itself
  // as seconds old. File activity is still surfaced (see
  // `lastActivityAt`) but only as the secondary signal it can support.
  ageAt: number | null;
  // Newest mtime outside dependency/build dirs. Meaningful mainly for a
  // worktree that has been edited since its last commit.
  lastActivityAt: number | null;
}

export type TidySort = "recommended" | "size" | "age";

export const TIDY_SORT_OPTIONS = [
  { value: "recommended" as const, label: "Recommended" },
  { value: "size" as const, label: "Size" },
  { value: "age" as const, label: "Age" },
];

// Display order when sorting by "Recommended": the removable ones first,
// then increasingly attached work, with the primary checkout pinned last
// since it can never be removed.
const VERDICT_RANK: Record<HygieneVerdictKind, number> = {
  merged: 0,
  absorbed: 1,
  unknown: 2,
  active: 3,
  unpushed: 4,
  dirty: 5,
  primary: 6,
};

export function buildTidyEntries(
  worktrees: Worktree[],
  hygieneById: Map<string, WorktreeHygiene>,
  diskById: Map<string, WorktreeDiskUsage>,
): TidyEntry[] {
  return worktrees.map((worktree) => {
    const hygiene = hygieneById.get(worktree.id);
    const disk = diskById.get(worktree.id);
    return {
      worktree,
      hygiene,
      disk,
      verdict: deriveHygieneVerdict(worktree, hygiene),
      ageAt: hygiene?.lastCommitAt ?? disk?.lastActivityAt ?? null,
      lastActivityAt: disk?.lastActivityAt ?? null,
    };
  });
}

// A worktree whose size hasn't landed sorts as 0 and an unknown age
// sorts as "newest", so unmeasured rows sink to the bottom rather than
// jumping to the top of a destructive list.
const bytes = (entry: TidyEntry) => entry.disk?.bytes ?? 0;
const age = (entry: TidyEntry) => entry.ageAt ?? Number.MAX_SAFE_INTEGER;

export function sortTidyEntries(
  entries: TidyEntry[],
  sort: TidySort,
): TidyEntry[] {
  return entries.toSorted((a, b) => {
    if (sort === "size") return bytes(b) - bytes(a);
    if (sort === "age") return age(a) - age(b);
    const rank = VERDICT_RANK[a.verdict.kind] - VERDICT_RANK[b.verdict.kind];
    return rank !== 0 ? rank : bytes(b) - bytes(a);
  });
}

// The rows we are willing to tick on the user's behalf. Nothing dirty,
// unmerged, detached or primary ever appears here -- that is the whole
// safety guarantee of the page, so it lives in one function.
export function defaultSelection(entries: TidyEntry[]): Set<string> {
  return new Set(
    entries
      .filter((entry) => entry.verdict.safe)
      .map((entry) => entry.worktree.id),
  );
}

export function isSelectable(entry: TidyEntry): boolean {
  return entry.verdict.kind !== "primary";
}

export interface TidySummary {
  selected: TidyEntry[];
  // Selected rows the page would not have ticked itself. Non-empty means
  // the confirm step demands an extra acknowledgement.
  risky: TidyEntry[];
  // Bytes freed by the current selection, counting only measured rows.
  reclaimBytes: number;
  // True when some selected row hasn't finished measuring, so the
  // reclaim figure is a floor.
  reclaimPartial: boolean;
}

export function summarize(
  entries: TidyEntry[],
  selected: ReadonlySet<string>,
): TidySummary {
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
