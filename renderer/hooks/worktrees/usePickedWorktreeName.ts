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
    // Re-roll on every visit (gcTime drops the pick as soon as the form
    // unmounts), but never while the form is open: a random pick has no
    // freshness to refetch for, and a window-focus refetch would swap
    // the suggested branch/folder name out from under the user.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    gcTime: 0,
    meta: { errorTitle: "Couldn't pick worktree name" },
  });
}
