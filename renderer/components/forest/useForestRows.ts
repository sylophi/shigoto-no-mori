import { useAllProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import {
  type ForestSort,
  type Project,
  type PullRequest,
  type Worktree,
  worktreeLastActivityAt,
} from "@shared/schemas";
import {
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
  // Projects that hold at least one worktree, pre-filter. Not the same
  // as projects.length: a project can be registered and empty.
  plantedProjects: number;
  // Every worktree in the forest, filtered by nothing -- the
  // denominator in "5 of 23 worktrees".
  total: number;
  shown: number;
  isLoading: boolean;
  failedCount: number;
}

interface UseForestRowsArgs {
  projects: Project[];
  facet: ForestFacet;
  sort: ForestSort;
  query: string;
}

function buildEntry(
  worktree: Worktree,
  pullRequest: PullRequest | undefined,
): ForestEntry {
  const date = worktree.recentCommits[0]?.date;
  const parsed = date ? Date.parse(date) : Number.NaN;
  return {
    worktree,
    pullRequest,
    attention: needsAttention(worktree, pullRequest),
    lastCommitAt: Number.isNaN(parsed) ? null : parsed,
    lastActivityAt: worktreeLastActivityAt(worktree),
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
}: UseForestRowsArgs): ForestData {
  const worktreeQueries = useAllProjectWorktrees(projects);
  const pullRequestQueries = useAllProjectPullRequests(projects);

  const groups: ForestGroup[] = [];
  const counts: Record<ForestFacet, number> = {
    all: 0,
    attention: 0,
    dirty: 0,
    pullRequest: 0,
  };
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
    const entries = (worktreeQuery.data ?? []).map((worktree) =>
      buildEntry(worktree, pullRequests?.[worktree.branch]),
    );
    if (entries.length > 0) plantedProjects++;
    total += entries.length;
    const matched = entries.filter((entry) =>
      matchesQuery(entry, query, project.name),
    );
    for (const entry of matched) {
      counts.all++;
      if (entry.attention) counts.attention++;
      if (entry.worktree.changedCount > 0) counts.dirty++;
      if (entry.pullRequest) counts.pullRequest++;
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
    plantedProjects,
    total,
    shown,
    isLoading,
    failedCount,
  };
}
