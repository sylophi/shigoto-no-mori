import { useQuery } from "@tanstack/react-query";
import type { WorktreeIncludeStatus } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export function useWorktreeIncludeStatus(projectId: string | null) {
  return useQuery<WorktreeIncludeStatus | null>({
    queryKey: queryKeys.worktreeIncludeStatus(projectId),
    queryFn: () => {
      if (!projectId) return null;
      return window.api.projects.worktreeIncludeStatus(projectId);
    },
    enabled: projectId !== null,
    meta: { errorTitle: "Couldn't read .worktreeinclude" },
  });
}
