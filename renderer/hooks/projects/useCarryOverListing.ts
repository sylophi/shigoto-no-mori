import { useQuery } from "@tanstack/react-query";
import type { CarryOverCandidate } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// The picker's view of one folder, unioned across the primary and every
// worktree (main/lib/worktrees/carryOver.ts).
export function useCarryOverListing(projectId: string, relative: string) {
  return useQuery<CarryOverCandidate[]>({
    queryKey: queryKeys.carryOverListing(projectId, relative),
    queryFn: () =>
      window.api.projects.carryOverListing({ projectId, relative }),
    // Each fetch walks every checkout's ignored tree in main. Dampen the
    // global refetch-on-focus so Cmd-Tabbing while the picker is open
    // doesn't re-walk them, same as useWorktreeIncludeStatus.
    staleTime: 15_000,
    meta: { errorTitle: "Couldn't read folder" },
  });
}
