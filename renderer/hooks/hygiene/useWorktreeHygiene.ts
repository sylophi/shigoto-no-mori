import { useQueries } from "@tanstack/react-query";
import type {
  Project,
  WorktreeDiskUsage,
  WorktreeHygiene,
} from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Git-derived staleness and merge facts, asked one project at a time and
// merged into a single lookup for the app-wide tidy page.
//
// The IPC call stays project-scoped even though the page is not: the
// per-project key is the one the rest of the app already invalidates,
// each project's facts land as soon as that repo answers, and a project
// whose directory has gone missing fails on its own instead of taking
// every other project's results down with it.
export interface ProjectHygiene {
  // Facts by worktree id. Ids are path hashes, so they stay unique
  // across projects and one flat map is enough.
  byId: Map<string, WorktreeHygiene>;
  // True while at least one project is still being read.
  loading: boolean;
}

export function useAllProjectHygiene(projects: Project[]): ProjectHygiene {
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.worktreeHygiene(project.id),
      queryFn: () => window.api.hygiene.list(project.id),
      // The sweep costs several git calls per worktree per project, and
      // the app's defaults refetch on every mount and window focus. A
      // window matching the disk cache keeps an alt-tab from re-probing
      // every repo; the removal flow invalidates explicitly, which
      // ignores staleTime.
      staleTime: 60_000,
      // Same reason the sidebar's worktree lists stay quiet: a project
      // folder that moved would otherwise raise one toast per project.
      meta: { silentError: true },
    })),
    combine: (results): ProjectHygiene => {
      const byId = new Map<string, WorktreeHygiene>();
      for (const result of results) {
        for (const facts of result.data ?? [])
          byId.set(facts.worktreeId, facts);
      }
      return { byId, loading: results.some((result) => result.isPending) };
    },
  });
}

export interface DiskUsageTotals {
  byId: Map<string, WorktreeDiskUsage>;
  // Bytes summed over the worktrees that have finished measuring, so the
  // total can be shown climbing rather than withheld until the end.
  measuredBytes: number;
  measuredCount: number;
  totalCount: number;
  // True while at least one walk is still running.
  measuring: boolean;
  // True when any finished walk hit unreadable entries, making the total
  // a floor. The UI marks the figure approximate.
  partial: boolean;
}

// What a disk query needs to identify its worktree. Taking the pair
// rather than a project id plus a list of worktree ids is what lets the
// page mix worktrees from different projects in one call.
export interface DiskUsageTarget {
  projectId: string;
  id: string;
}

// One query per worktree, in parallel. Each disk walk is independent, so
// sizes fill in as they land instead of the page blocking on the largest
// checkout -- which on a repo with node_modules is the whole point.
// Main caps how many walks actually run at once, so asking for every
// worktree in every project here is safe.
//
// Errors are silent: a worktree that vanished mid-measure should leave
// one dash in the table, not a toast.
export function useWorktreeDiskUsage(
  worktrees: DiskUsageTarget[],
): DiskUsageTotals {
  return useQueries({
    queries: worktrees.map(({ projectId, id }) => ({
      queryKey: queryKeys.worktreeDiskUsage(projectId, id),
      queryFn: () =>
        window.api.hygiene.diskUsage({ projectId, worktreeId: id }),
      // Matches the main-side cache TTL, so a remount inside the window
      // reuses the walk instead of paying for it twice.
      staleTime: 60_000,
      meta: { silentError: true },
    })),
    combine: (results): DiskUsageTotals => {
      const byId = new Map<string, WorktreeDiskUsage>();
      let measuredBytes = 0;
      let partial = false;
      for (const result of results) {
        if (!result.data) continue;
        byId.set(result.data.worktreeId, result.data);
        measuredBytes += result.data.bytes;
        if (result.data.partial) partial = true;
      }
      return {
        byId,
        measuredBytes,
        measuredCount: byId.size,
        totalCount: results.length,
        measuring: results.some((result) => result.isPending),
        partial,
      };
    },
  });
}
