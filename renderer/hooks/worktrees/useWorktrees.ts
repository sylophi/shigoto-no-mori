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
    // Sidebar renders inline "Failed to list worktrees" + the project-
    // missing affordance handles the dominant ENOENT case.
    meta: { silentError: true },
  });
}

export function useWorktrees(projectId: string | null) {
  return useQuery(worktreesQueryOptions(projectId));
}

// One query per project, sharing the per-project cache key with useWorktrees.
// `enabled` toggles them all off when the consumer isn't visible (launcher).
// Skip projects whose path is gone — git would just ENOENT.
export function useAllProjectWorktrees(projects: Project[], enabled = true) {
  return useQueries({
    queries: projects.map((project) => ({
      ...worktreesQueryOptions(project.id),
      enabled: enabled && project.pathExists !== false,
    })),
  });
}

// The shape useAllProjectWorktrees hands back, positionally aligned with
// the `projects` it was given. Named so the sidebar's row builders can
// take it as a plain argument instead of each calling the hook again.
export type ProjectWorktreeQueries = ReturnType<typeof useAllProjectWorktrees>;
