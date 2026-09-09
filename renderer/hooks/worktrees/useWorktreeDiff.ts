import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

// One file's working-tree diff, read when the changes page picks it.
// Keyed by the paths asked for, so switching back to a file already
// looked at is instant and the query cache is the only place a patch
// lives. Refetched like everything else derived from the tree: on
// mount, on focus, and when a commit or discard invalidates it.
export function useFileDiff(
  projectId: string,
  worktreeId: string | undefined,
  paths: readonly string[],
  untracked: boolean,
) {
  return useQuery<string>({
    queryKey: queryKeys.worktreeFileDiff(projectId, worktreeId, paths),
    queryFn: () => {
      if (!worktreeId || paths.length === 0) return "";
      return window.api.worktrees.fileDiff({
        projectId,
        worktreeId,
        paths: [...paths],
        untracked,
      });
    },
    enabled: !!worktreeId && paths.length > 0,
    staleTime: 0,
    // Every file looked at leaves a patch behind, and a long review
    // looks at a lot of them. The data is stale on arrival anyway, so
    // holding it only buys an instant second look at the same file.
    gcTime: 60_000,
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
