import { useQuery } from "@tanstack/react-query";

export function usePickedWorktreeName(projectId: string | null) {
  return useQuery<string>({
    queryKey: ["picked-worktree-name", projectId],
    queryFn: () => {
      if (!projectId) return "";
      return window.api.projects.pickWorktreeName(projectId);
    },
    enabled: projectId !== null,
    // Re-roll on every mount.
    staleTime: 0,
    gcTime: 0,
  });
}
