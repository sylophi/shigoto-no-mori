import { useQuery } from "@tanstack/react-query";

// Picks an animal name not currently used by any worktree in the project.
// The result is what `createWorktree` will use for the new worktree's
// dirname unless the renderer overrides it. Resolved once per mount so
// the form's preview stays stable while the user is editing.
export function usePickedWorktreeName(projectId: string | null) {
  return useQuery<string>({
    queryKey: ["picked-worktree-name", projectId],
    queryFn: () => {
      if (!projectId) return "";
      return window.api.projects.pickWorktreeName(projectId);
    },
    enabled: projectId !== null,
    // Fresh on every mount of the NewWorktree page; navigating away and
    // back should re-roll.
    staleTime: 0,
    gcTime: 0,
  });
}
