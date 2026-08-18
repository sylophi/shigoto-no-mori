import { useQueries, useQuery } from "@tanstack/react-query";
import type { WorktreeDiskUsage, WorktreeHygiene } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Git-derived staleness and merge facts for every worktree in a project.
// Cheap enough to gate the list on.
export function useWorktreeHygiene(projectId: string | null) {
  return useQuery<WorktreeHygiene[]>({
    queryKey: queryKeys.worktreeHygiene(projectId),
    queryFn: () => {
      if (!projectId) return [];
      return window.api.hygiene.list(projectId);
    },
    enabled: projectId !== null,
    meta: { errorTitle: "Couldn't check worktree hygiene" },
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

// One query per worktree, in parallel. Each disk walk is independent, so
// sizes fill in as they land instead of the page blocking on the largest
// checkout -- which on a repo with node_modules is the whole point.
//
// Errors are silent: a worktree that vanished mid-measure should leave
// one dash in the table, not a toast.
export function useWorktreeDiskUsage(
  projectId: string,
  worktreeIds: string[],
): DiskUsageTotals {
  return useQueries({
    queries: worktreeIds.map((worktreeId) => ({
      queryKey: queryKeys.worktreeDiskUsage(projectId, worktreeId),
      queryFn: () => window.api.hygiene.diskUsage({ projectId, worktreeId }),
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
