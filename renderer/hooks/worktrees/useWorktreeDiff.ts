import { useQuery } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useWorktreeDiff(
  projectId: string,
  worktreeId: string | undefined,
) {
  const { api, keys } = useHostScope();
  return useQuery<string>({
    queryKey: keys.worktreeDiff(projectId, worktreeId),
    queryFn: () => {
      if (!worktreeId) return "";
      return api.worktrees.diff({ projectId, worktreeId });
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
  const { api, keys } = useHostScope();
  return useQuery<string>({
    queryKey: keys.commitDiff(projectId, worktreeId, hash),
    queryFn: () => {
      if (!worktreeId) return "";
      return api.worktrees.commitDiff({ projectId, worktreeId, hash });
    },
    enabled: !!worktreeId && hash.length > 0,
    staleTime: Infinity,
    meta: { errorTitle: "Couldn't compute diff" },
  });
}
