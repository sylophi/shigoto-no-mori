import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import type { Project, Worktree } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Single source of truth for the worktrees-list query, so imperative
// fetches (e.g. queryClient.ensureQueryData) hit the same cache entry
// and config as the hooks below.
export function worktreesQueryOptions(projectId: string | null) {
  return queryOptions<Worktree[]>({
    queryKey: queryKeys.worktrees(projectId),
    queryFn: () => {
      if (!projectId) return [];
      return window.api.worktrees.list(projectId);
    },
    enabled: projectId !== null,
    // Four components observe this key and listing costs ~4 git subprocesses
    // per worktree. Without a window, opening the launcher re-lists every
    // project for data the sidebar just fetched. Short enough that focus
    // refetches and invalidations still behave as before.
    staleTime: 3_000,
    // Sidebar renders inline "Failed to list worktrees" + the project-
    // missing affordance handles the dominant ENOENT case.
    meta: { silentError: true },
  });
}

// Shared by the two sidebar fan-outs; see useAllProjectWorktrees.
export function combineFanOut<T>(
  results: readonly {
    data: T | undefined;
    error: Error | null;
    isLoading: boolean;
    isPending: boolean;
  }[],
) {
  return results.map((result) => ({
    data: result.data,
    error: result.error,
    isLoading: result.isLoading,
    isPending: result.isPending,
  }));
}

export function useWorktrees(projectId: string | null) {
  return useQuery(worktreesQueryOptions(projectId));
}

// One query per project, sharing the per-project cache key with useWorktrees.
// `enabled` toggles them all off when the consumer isn't visible (launcher).
// Skip projects whose path is gone — git would just ENOENT.
// Without a `combine`, useQueries hands back a fresh array of fresh
// objects every render, so nothing downstream can stay memoized.
// Projecting to the fields consumers read routes it through
// replaceEqualDeep, which keeps identity when nothing changed.
export function useAllProjectWorktrees(projects: Project[], enabled = true) {
  return useQueries({
    queries: projects.map((project) => ({
      ...worktreesQueryOptions(project.id),
      enabled: enabled && project.pathExists !== false,
    })),
    combine: combineFanOut,
  });
}

// The shape useAllProjectWorktrees hands back, positionally aligned with
// the `projects` it was given. Named so the sidebar's row builders can
// take it as a plain argument instead of each calling the hook again.
export type ProjectWorktreeQueries = ReturnType<typeof useAllProjectWorktrees>;
