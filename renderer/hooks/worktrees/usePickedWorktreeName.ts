import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export function usePickedWorktreeName(projectId: string | null) {
  return useQuery<string>({
    queryKey: queryKeys.pickedWorktreeName(projectId),
    queryFn: () => {
      if (!projectId) return "";
      return window.api.projects.pickWorktreeName(projectId);
    },
    enabled: projectId !== null,
    // Re-roll on every mount.
    staleTime: 0,
    gcTime: 0,
    meta: { errorTitle: "Couldn't pick worktree name" },
  });
}
