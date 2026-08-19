import {
  deriveHygieneVerdict,
  type HygieneVerdict,
  type HygieneVerdictKind,
  type Project,
  type Worktree,
  type WorktreeDiskUsage,
  type WorktreeHygiene,
} from "@shared/schemas";

// One row on the tidy page: the worktree, the project it belongs to, and
// everything we judged about it. `disk` is undefined until that
// worktree's walk lands.
export interface TidyEntry {
  worktree: Worktree;
  // Carried on the row because the page spans every project: without it
  // two worktrees called "misty-otter" in different repos are
  // indistinguishable, and the confirm step would name a directory the
  // user can't place.
  project: Project;
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

export type TidySort = "recommended" | "size" | "age" | "project";

export const TIDY_SORT_OPTIONS = [
  { value: "recommended" as const, label: "Recommended" },
  { value: "size" as const, label: "Size" },
  { value: "age" as const, label: "Age" },
  { value: "project" as const, label: "Project" },
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
  projects: Project[],
  worktreesByProject: Map<string, Worktree[]>,
  hygieneById: Map<string, WorktreeHygiene>,
  diskById: Map<string, WorktreeDiskUsage>,
): TidyEntry[] {
  return projects.flatMap((project) =>
    (worktreesByProject.get(project.id) ?? []).map((worktree) => {
      const hygiene = hygieneById.get(worktree.id);
      const disk = diskById.get(worktree.id);
      return {
        worktree,
        project,
        hygiene,
        disk,
        verdict: deriveHygieneVerdict(worktree, hygiene),
        ageAt: hygiene?.lastCommitAt ?? disk?.lastActivityAt ?? null,
        lastActivityAt: disk?.lastActivityAt ?? null,
      };
    }),
  );
}

// A worktree whose size hasn't landed sorts as 0 and an unknown age
// sorts as "newest", so unmeasured rows sink to the bottom rather than
// jumping to the top of a destructive list.
const bytes = (entry: TidyEntry) => entry.disk?.bytes ?? 0;
const age = (entry: TidyEntry) => entry.ageAt ?? Number.MAX_SAFE_INTEGER;
const rank = (entry: TidyEntry) => VERDICT_RANK[entry.verdict.kind];

export function sortTidyEntries(
  entries: TidyEntry[],
  sort: TidySort,
): TidyEntry[] {
  return entries.toSorted((a, b) => {
    if (sort === "size") return bytes(b) - bytes(a);
    if (sort === "age") return age(a) - age(b);
    if (sort === "project") {
      // Keeps every project's rows contiguous so the list can be broken
      // into labelled groups, and orders within a project exactly the
      // way "Recommended" would.
      const byProject = a.project.name.localeCompare(b.project.name);
      if (byProject !== 0) return byProject;
      return rank(a) - rank(b) || bytes(b) - bytes(a);
    }
    return rank(a) - rank(b) || bytes(b) - bytes(a);
  });
}

export interface TidyGroup {
  project: Project;
  entries: TidyEntry[];
  // Measured bytes across the group, so a project's header can carry the
  // number that decides whether it is worth opening at all.
  bytes: number;
}

// Splits an already-sorted list into the runs of one project each. Only
// the "Project" sort produces contiguous runs, so this is only asked for
// there -- every other sort is deliberately one flat cross-project list.
export function groupByProject(entries: TidyEntry[]): TidyGroup[] {
  const groups: TidyGroup[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last?.project.id === entry.project.id) {
      last.entries.push(entry);
      last.bytes += bytes(entry);
    } else {
      groups.push({
        project: entry.project,
        entries: [entry],
        bytes: bytes(entry),
      });
    }
  }
  return groups;
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
  // How many distinct projects the selection reaches into. The confirm
  // step leads with this: removing worktrees from four repos at once is
  // a different act from tidying one.
  projectCount: number;
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
    projectCount: new Set(picked.map((entry) => entry.project.id)).size,
    reclaimBytes: picked.reduce(
      (sum, entry) => sum + (entry.disk?.bytes ?? 0),
      0,
    ),
    reclaimPartial: picked.some((entry) => entry.disk === undefined),
  };
}
