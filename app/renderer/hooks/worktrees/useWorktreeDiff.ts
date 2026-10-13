import { useQuery, skipToken } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useTreeView } from "@/hooks/worktrees/useWorktreeChanges";

// One file's working-tree diff, read when the changes page picks it:
// the host's view, read again as the tree moves.
export function useFileDiff(
  projectId: string,
  worktreeId: string,
  paths: readonly string[],
  untracked: boolean,
) {
  return useTreeView<string>(
    "watchFileDiff",
    paths.length === 0
      ? null
      : { projectId, worktreeId, paths: [...paths], untracked },
    "Couldn't compute diff",
  );
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
        ? ({ signal }) =>
            api.run(api.worktrees.commitDiff({ projectId, worktreeId, hash }), {
              signal,
            })
        : skipToken,
    staleTime: Infinity,
    meta: { errorTitle: "Couldn't compute diff" },
  });
}

// What the branch changes against the primary branch, the way a pull
// request would show it. Read afresh on each visit: the branch moves.
export function useBranchDiff(
  projectId: string,
  worktreeId: string | undefined,
) {
  const { api, keys } = useHostScope();
  return useQuery<string>({
    queryKey: keys.branchDiff(projectId, worktreeId ?? ""),
    queryFn: worktreeId
      ? ({ signal }) =>
          api.run(api.worktrees.branchDiff({ projectId, worktreeId }), {
            signal,
          })
      : skipToken,
    staleTime: 0,
    meta: { errorTitle: "Couldn't compute diff" },
  });
}

// What a stash holds. A stash's commit never changes, so like a
// commit's diff it is kept.
export function useStashDiff(
  projectId: string,
  worktreeId: string | undefined,
  hash: string,
) {
  const { api, keys } = useHostScope();
  return useQuery<string>({
    queryKey: keys.stashDiff(projectId, worktreeId ?? "", hash),
    queryFn:
      worktreeId && hash
        ? ({ signal }) =>
            api.run(api.worktrees.stashDiff({ projectId, worktreeId, hash }), {
              signal,
            })
        : skipToken,
    staleTime: Infinity,
    meta: { errorTitle: "Couldn't read the stash" },
  });
}
