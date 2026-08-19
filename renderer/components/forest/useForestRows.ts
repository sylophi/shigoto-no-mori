import {
  useAllProjectHygiene,
  useForestDiskUsage,
  type DiskUsageTotals,
} from "@/hooks/hygiene/useWorktreeHygiene";
import { useAllProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import {
  deriveHygieneVerdict,
  type ForestSort,
  type Project,
  type PullRequest,
  type Worktree,
  type WorktreeDiskUsage,
  type WorktreeHygiene,
  worktreeLastActivityAt,
} from "@shared/schemas";
import {
  isSelectable,
  matchesFacet,
  matchesQuery,
  needsAttention,
  sortEntries,
  type ForestEntry,
  type ForestFacet,
} from "./forestFilters";

export interface ForestGroup {
  project: Project;
  entries: ForestEntry[];
}

export interface ForestData {
  // Projects with at least one worktree left after filtering, in the
  // order they were handed in (i.e. the sidebar's project order).
  groups: ForestGroup[];
  // Counts under the text filter but before the facet, because they
  // label the facet buttons and have to promise what picking that facet
  // would actually show. Counting pre-query would offer you "Attention
  // 7" and then hand you an empty screen.
  counts: Record<ForestFacet, number>;
  // The same counts over the whole forest, filtered by nothing. The
  // tidy strip is a survey of everything you own, so it must not move
  // when you type in the filter box.
  totals: Record<ForestFacet, number>;
  // Projects that hold at least one worktree, pre-filter. Not the same
  // as projects.length: a project can be registered and empty.
  plantedProjects: number;
  // Every worktree in the forest, filtered by nothing -- the
  // denominator in "5 of 23 worktrees".
  total: number;
  shown: number;
  // Every entry in the forest, flat and filtered by nothing. Tidy mode
  // works off this rather than off what's visible: a tick has to survive
  // you typing in the filter box, and the batch has to remove what the
  // dialog listed, not what happened to be on screen when you confirmed.
  all: ForestEntry[];
  // How many of those a checkbox will ever accept, i.e. everything but
  // each project's primary checkout. The denominator in "3 of 12
  // selected".
  selectableCount: number;
  disk: DiskUsageTotals;
  isLoading: boolean;
  failedCount: number;
}

interface UseForestRowsArgs {
  projects: Project[];
  facet: ForestFacet;
  sort: ForestSort;
  query: string;
  // Tidy mode. Measuring every checkout of every project is the one
  // expensive thing here, so the walk waits until you ask for it.
  measureDisk: boolean;
}

function buildEntry(
  worktree: Worktree,
  pullRequest: PullRequest | undefined,
  hygiene: WorktreeHygiene | undefined,
  disk: WorktreeDiskUsage | undefined,
): ForestEntry {
  const date = worktree.recentCommits[0]?.date;
  const parsed = date ? Date.parse(date) : Number.NaN;
  return {
    worktree,
    pullRequest,
    attention: needsAttention(worktree, pullRequest),
    lastCommitAt: Number.isNaN(parsed) ? null : parsed,
    lastActivityAt: worktreeLastActivityAt(worktree),
    verdict: deriveHygieneVerdict(worktree, hygiene),
    disk,
  };
}

// Flattens every project's worktrees into per-project groups for the
// forest overview, applying the active facet, text query, and sort.
// Both fan-outs share their cache keys with the sidebar, so the data is
// already in cache when this screen opens -- though the app-wide
// `refetchOnMount: "always"` default means a second observer still
// revalidates, same as the launcher's fan-out does. Deliberately not
// memoized, for the same reason useSidebarRows isn't: useQueries hands
// back a fresh array every render and a correct dependency would need a
// deep fingerprint.
export function useForestRows({
  projects,
  facet,
  sort,
  query,
  measureDisk,
}: UseForestRowsArgs): ForestData {
  const worktreeQueries = useAllProjectWorktrees(projects);
  const pullRequestQueries = useAllProjectPullRequests(projects);
  const hygieneQueries = useAllProjectHygiene(projects);
  // Every worktree in the forest, flat, so the disk fan-out is one query
  // per checkout rather than one per project.
  const refs = projects.flatMap((project, i) =>
    (worktreeQueries[i]?.data ?? []).map((worktree) => ({
      projectId: project.id,
      worktreeId: worktree.id,
    })),
  );
  const disk = useForestDiskUsage(refs, measureDisk);

  const groups: ForestGroup[] = [];
  const counts: Record<ForestFacet, number> = {
    all: 0,
    attention: 0,
    dirty: 0,
    pullRequest: 0,
    safe: 0,
  };
  const totals: Record<ForestFacet, number> = {
    all: 0,
    attention: 0,
    dirty: 0,
    pullRequest: 0,
    safe: 0,
  };
  const all: ForestEntry[] = [];
  let plantedProjects = 0;
  let total = 0;
  let shown = 0;
  let isLoading = false;
  let failedCount = 0;

  projects.forEach((project, i) => {
    if (project.pathExists === false) return;
    const worktreeQuery = worktreeQueries[i];
    if (!worktreeQuery) return;
    if (worktreeQuery.isLoading) {
      isLoading = true;
      return;
    }
    if (worktreeQuery.error) {
      failedCount++;
      return;
    }
    const pullRequests = pullRequestQueries[i]?.data;
    const hygieneById = new Map(
      (hygieneQueries[i]?.data ?? []).map((facts) => [facts.worktreeId, facts]),
    );
    const entries = (worktreeQuery.data ?? []).map((worktree) =>
      buildEntry(
        worktree,
        pullRequests?.[worktree.branch],
        hygieneById.get(worktree.id),
        disk.byId.get(worktree.id),
      ),
    );
    if (entries.length > 0) plantedProjects++;
    total += entries.length;
    all.push(...entries);
    for (const entry of entries) {
      tally(totals, entry);
    }
    const matched = entries.filter((entry) =>
      matchesQuery(entry, query, project.name),
    );
    for (const entry of matched) {
      tally(counts, entry);
    }
    const visible = matched.filter((entry) => matchesFacet(entry, facet));
    shown += visible.length;
    if (visible.length > 0) {
      groups.push({ project, entries: sortEntries(visible, sort) });
    }
  });

  return {
    groups,
    counts,
    totals,
    plantedProjects,
    total,
    shown,
    all,
    selectableCount: all.filter(isSelectable).length,
    disk,
    isLoading,
    failedCount,
  };
}

function tally(counts: Record<ForestFacet, number>, entry: ForestEntry): void {
  counts.all++;
  if (entry.attention) counts.attention++;
  if (entry.worktree.changedCount > 0) counts.dirty++;
  if (entry.pullRequest) counts.pullRequest++;
  if (entry.verdict.safe) counts.safe++;
}
