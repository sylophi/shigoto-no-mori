import { useQuery, skipToken } from "@tanstack/react-query";
import type { WorktreeIncludeStatus } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useWorktreeIncludeStatus(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<WorktreeIncludeStatus | null>({
    queryKey: keys.worktreeIncludeStatus(projectId),
    queryFn:
      projectId !== null
        ? ({ signal }) =>
            api.run(api.projects.worktreeIncludeStatus({ projectId }), {
              signal,
            })
        : skipToken,
    // Each fetch spawns two `git ls-files` enumerations on the host. Dampen
    // the global refetch-on-focus/mount so Cmd-Tabbing around while
    // Configure is open doesn't re-walk the ignored tree every time.
    // Reconciliation events invalidate this key explicitly.
    staleTime: 15_000,
    meta: { errorTitle: "Couldn't read .worktreeinclude" },
  });
}
