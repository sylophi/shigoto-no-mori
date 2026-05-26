import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export function useWorktreeDiff(
  projectId: string,
  worktreeId: string | undefined,
) {
  return useQuery<string>({
    queryKey: queryKeys.worktreeDiff(projectId, worktreeId),
    queryFn: () => {
      if (!worktreeId) return "";
      return window.api.worktrees.diff({ projectId, worktreeId });
    },
    enabled: !!worktreeId,
    // Diff reflects working-tree state, which mutates outside our control;
    // always refetch on mount so re-entering the page shows current state.
    staleTime: 0,
    meta: { errorTitle: "Couldn't compute diff" },
  });
}

// Commit diffs are immutable once the commit exists, so we can cache them
// indefinitely. Keyed by hash so different commits don't share a slot.
export function useCommitDiff(
  projectId: string,
  worktreeId: string | undefined,
  hash: string,
) {
  return useQuery<string>({
    queryKey: queryKeys.commitDiff(projectId, worktreeId, hash),
    queryFn: () => {
      if (!worktreeId) return "";
      return window.api.worktrees.commitDiff({ projectId, worktreeId, hash });
    },
    enabled: !!worktreeId && hash.length > 0,
    staleTime: Infinity,
    meta: { errorTitle: "Couldn't compute diff" },
  });
}
