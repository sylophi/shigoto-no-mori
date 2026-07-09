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
    // Each fetch spawns two `git ls-files` enumerations in main. Dampen
    // the global refetch-on-focus/mount so Cmd-Tabbing around while
    // Configure is open doesn't re-walk the ignored tree every time;
    // reconciliation events invalidate this key explicitly.
    staleTime: 15_000,
    meta: { errorTitle: "Couldn't read .worktreeinclude" },
  });
}
