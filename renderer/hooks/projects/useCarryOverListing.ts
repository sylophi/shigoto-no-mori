import { useQuery } from "@tanstack/react-query";
import type { CarryOverCandidate } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

// The picker's view of one folder, unioned across the primary and every
// worktree (host/lib/worktrees/carryOver.ts).
export function useCarryOverListing(projectId: string, relative: string) {
  const { api, keys } = useHostScope();
  return useQuery<CarryOverCandidate[]>({
    queryKey: keys.carryOverListing(projectId, relative),
    queryFn: () => api.projects.carryOverListing({ projectId, relative }),
    // Each fetch walks every checkout's ignored tree on the host. Dampen
    // the global refetch-on-focus so Cmd-Tabbing while the picker is open
    // doesn't re-walk them, same as useWorktreeIncludeStatus.
    staleTime: 15_000,
    meta: { errorTitle: "Couldn't read folder" },
  });
}
