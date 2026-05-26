import { useQueries, useQuery } from "@tanstack/react-query";
import type { Project, Worktree } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export function useWorktrees(projectId: string | null) {
  return useQuery<Worktree[]>({
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

// One query per project, sharing the per-project cache key with useWorktrees.
// `enabled` toggles them all off when the consumer isn't visible (palette).
// Skip projects whose path is gone — git would just ENOENT.
export function useAllProjectWorktrees(projects: Project[], enabled = true) {
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.worktrees(project.id),
      queryFn: () => window.api.worktrees.list(project.id),
      enabled: enabled && project.pathExists !== false,
      meta: { silentError: true },
    })),
  });
}
