import { useQueries } from "@tanstack/react-query";
import type { Project, WorktreeDiskUsage } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Git-derived staleness and merge facts for every worktree in a project,
// one query per project. Cheap enough to gate the list on, so unlike the
// disk walk below this runs whether or not you are tidying. Skips
// projects whose path is gone, and stays silent, because a forest-wide
// fan-out would otherwise fire one toast per broken project.
export function useAllProjectHygiene(projects: Project[]) {
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.worktreeHygiene(project.id),
      queryFn: () => window.api.hygiene.list(project.id),
      enabled: project.pathExists !== false,
      meta: { silentError: true },
    })),
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

export interface WorktreeRef {
  projectId: string;
  worktreeId: string;
}

// One query per worktree, in parallel, across every project. Each disk
// walk is independent, so sizes fill in as they land instead of the page
// blocking on the largest checkout, which on a repo with node_modules is
// the whole point. `enabled` is how the forest keeps its survey cheap:
// measuring every checkout of every project is the one expensive thing
// on the screen, so it only runs once you ask to tidy.
//
// Errors are silent: a worktree that vanished mid-measure should leave
// one dash in the table, not a toast.
export function useForestDiskUsage(
  refs: WorktreeRef[],
  enabled: boolean,
): DiskUsageTotals {
  return useQueries({
    queries: refs.map(({ projectId, worktreeId }) => ({
      queryKey: queryKeys.worktreeDiskUsage(projectId, worktreeId),
      queryFn: () => window.api.hygiene.diskUsage({ projectId, worktreeId }),
      // Matches the main-side cache TTL, so a remount inside the window
      // reuses the walk instead of paying for it twice.
      staleTime: 60_000,
      enabled,
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
        measuring: enabled && results.some((result) => result.isPending),
        partial,
      };
    },
  });
}
