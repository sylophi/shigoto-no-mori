import { useQuery, skipToken } from "@tanstack/react-query";
import type { WorktreeIncludeStatus } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useWorktreeIncludeStatus(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<WorktreeIncludeStatus | null>({
    queryKey: keys.worktreeIncludeStatus(projectId),
    queryFn:
      projectId !== null
        ? () => api.projects.worktreeIncludeStatus(projectId)
        : skipToken,
    // Each fetch spawns two `git ls-files` enumerations in main. Dampen
    // the global refetch-on-focus/mount so Cmd-Tabbing around while
    // Configure is open doesn't re-walk the ignored tree every time;
    // reconciliation events invalidate this key explicitly.
    staleTime: 15_000,
    meta: { errorTitle: "Couldn't read .worktreeinclude" },
  });
}
