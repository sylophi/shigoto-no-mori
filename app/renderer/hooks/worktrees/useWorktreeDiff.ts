import { useQuery, skipToken } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

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
  const { api, keys } = useHostScope();
  return useQuery<string>({
    queryKey: keys.worktreeFileDiff(projectId, worktreeId, paths, untracked),
    queryFn:
      worktreeId && paths.length > 0
        ? () =>
            api.worktrees.fileDiff({
              projectId,
              worktreeId,
              paths: [...paths],
              untracked,
            })
        : skipToken,
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
  const { api, keys } = useHostScope();
  return useQuery<string>({
    queryKey: keys.commitDiff(projectId, worktreeId, hash),
    queryFn:
      worktreeId && hash.length > 0
        ? () => api.worktrees.commitDiff({ projectId, worktreeId, hash })
        : skipToken,
    staleTime: Infinity,
    meta: { errorTitle: "Couldn't compute diff" },
  });
}
