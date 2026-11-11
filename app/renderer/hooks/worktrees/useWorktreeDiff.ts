import { queryOptions, useQuery, skipToken } from "@tanstack/react-query";
import { type HostScope, useHostScope } from "@/hooks/remote/useHostScope";
import { type ChangedFile, isUntracked } from "@shigomori/contracts/schemas";
import { changedFilePaths } from "@shigomori/ui/views/diff/changesControls.ts";
import { useTreeView } from "@/hooks/worktrees/useWorktreeChanges";

// What one changed file's diff view reads.
export function fileDiffInput(
  projectId: string,
  worktreeId: string,
  file: ChangedFile,
) {
  return {
    projectId,
    worktreeId,
    paths: changedFilePaths(file),
    untracked: isUntracked(file),
  };
}

// One file's working-tree diff, read when the changes page picks it:
// the host's view, read again as the tree moves.
export function useFileDiff(
  projectId: string,
  worktreeId: string,
  file: ChangedFile | null,
) {
  return useTreeView<string>(
    "watchFileDiff",
    file && fileDiffInput(projectId, worktreeId, file),
    "Couldn't compute diff",
  );
}

// Commit diffs are immutable once the commit exists, so we can cache them
// indefinitely. Keyed by hash so different commits don't share a slot.
export function commitDiffQuery(
  { api, keys }: Pick<HostScope, "api" | "keys">,
  projectId: string,
  worktreeId: string | undefined,
  hash: string,
) {
  return queryOptions<string>({
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

export function useCommitDiff(
  projectId: string,
  worktreeId: string | undefined,
  hash: string,
) {
  return useQuery(commitDiffQuery(useHostScope(), projectId, worktreeId, hash));
}

// What the branch changes against the primary branch, or `base`,
// uncommitted work included. Read afresh on each visit: the branch
// moves.
export function useBranchDiff(
  projectId: string,
  worktreeId: string | undefined,
  base: string | undefined,
) {
  const { api, keys } = useHostScope();
  return useQuery<string>({
    queryKey: keys.branchDiff(projectId, worktreeId ?? "", base),
    queryFn: worktreeId
      ? ({ signal }) =>
          api.run(api.worktrees.branchDiff({ projectId, worktreeId, base }), {
            signal,
          })
      : skipToken,
    staleTime: 0,
    meta: { errorTitle: "Couldn't compute diff" },
  });
}

// What a stash holds. A stash's commit never changes, so like a
// commit's diff it is kept.
export function stashDiffQuery(
  { api, keys }: Pick<HostScope, "api" | "keys">,
  projectId: string,
  worktreeId: string | undefined,
  hash: string,
) {
  return queryOptions<string>({
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

export function useStashDiff(
  projectId: string,
  worktreeId: string | undefined,
  hash: string,
) {
  return useQuery(stashDiffQuery(useHostScope(), projectId, worktreeId, hash));
}
