import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  GitOperationState,
  MergeBranchResult,
  IntegrateMethod,
  MergePreview,
  StashEntry,
  Worktree,
} from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  invalidateTreeState,
  invalidateWorkingTree,
  useWorkingTreeMutation,
} from "./useWorktreeChanges";

type Scope = { projectId: string; worktreeId: string };

// The commit menu's history moves. Each answers with the worktree it
// changed (for a cherry-pick, the one the commit landed on), which the
// working-tree refresh writes back.
export function useRevertCommit() {
  return useWorkingTreeMutation<Scope & { hash: string }, Worktree>(
    (api, input) => api.worktrees.revertCommit(input),
    (worktree) => worktree,
    "Couldn't revert the commit",
  );
}

export function useCherryPick() {
  return useWorkingTreeMutation<Scope & { hash: string }, Worktree>(
    (api, input) => api.worktrees.cherryPick(input),
    (worktree) => worktree,
    "Couldn't cherry-pick the commit",
  );
}

export function useRewordCommit() {
  return useWorkingTreeMutation<
    Scope & {
      hash: string;
      summary: string;
      description?: string;
      expectHead: string;
    },
    Worktree
  >(
    (api, input) => api.worktrees.rewordCommit(input),
    (worktree) => worktree,
    "Couldn't reword the commit",
  );
}

export function useSquashCommit() {
  return useWorkingTreeMutation<
    Scope & { hash: string; expectHead: string },
    Worktree
  >(
    (api, input) => api.worktrees.squashCommit(input),
    (worktree) => worktree,
    "Couldn't squash the commits",
  );
}

// The stashes made on the worktree's branch. Refetched with the rest of
// the project's git state when the host's watcher sees refs move.
export function useWorktreeStashes(worktree: Worktree | undefined) {
  const { api, keys } = useHostScope();
  return useQuery<readonly StashEntry[]>({
    queryKey: keys.worktreeStashes(
      worktree?.projectId ?? "",
      worktree?.id ?? "",
    ),
    queryFn: worktree
      ? () =>
          api.worktrees.stashes({
            projectId: worktree.projectId,
            worktreeId: worktree.id,
          })
      : skipToken,
    meta: { errorTitle: "Couldn't read the stashes" },
  });
}

function useInvalidateStashes() {
  const queryClient = useQueryClient();
  const { keys } = useHostScope();
  return ({ projectId, worktreeId }: Scope) =>
    void queryClient.invalidateQueries({
      queryKey: keys.worktreeStashes(projectId, worktreeId),
    });
}

// Stash and apply move the working tree as well as the list.
function useStashTreeMutation<Input extends Scope>(
  call: Parameters<typeof useWorkingTreeMutation<Input, Worktree>>[0],
  errorTitle: string,
) {
  const invalidateStashes = useInvalidateStashes();
  const mutation = useWorkingTreeMutation<Input, Worktree>(
    call,
    (worktree) => worktree,
    errorTitle,
  );
  const mutate: typeof mutation.mutate = (input, options) =>
    mutation.mutate(input, {
      ...options,
      onSettled: (...args) => {
        invalidateStashes(input);
        options?.onSettled?.(...args);
      },
    });
  return { ...mutation, mutate };
}

export function useStashChanges() {
  return useStashTreeMutation<Scope & { message?: string }>(
    (api, input) => api.worktrees.stashChanges(input),
    "Couldn't stash the changes",
  );
}

export function useApplyStash() {
  return useStashTreeMutation<Scope & { hash: string; drop: boolean }>(
    (api, input) => api.worktrees.applyStash(input),
    "Couldn't apply the stash",
  );
}

export function useDropStash() {
  const { api } = useHostScope();
  const invalidateStashes = useInvalidateStashes();
  return useMutation<void, Error, Scope & { hash: string }>({
    mutationFn: (input) => api.worktrees.dropStash(input),
    onSettled: (_data, _err, input) => invalidateStashes(input),
    meta: { errorTitle: "Couldn't drop the stash" },
  });
}

export function useRestoreStash() {
  const { api } = useHostScope();
  const invalidateStashes = useInvalidateStashes();
  return useMutation<
    void,
    Error,
    Scope & { hash: string; message: string; named: boolean }
  >({
    mutationFn: (input) => api.worktrees.restoreStash(input),
    onSettled: (_data, _err, input) => invalidateStashes(input),
    meta: { errorTitle: "Couldn't bring the stash back" },
  });
}

// The operation the worktree is stopped in, and how many files still
// conflict. Refetched with the working tree after every move here.
export function useWorktreeOperation(worktree: Worktree) {
  const { api, keys } = useHostScope();
  const { projectId, id: worktreeId } = worktree;
  return useQuery<GitOperationState>({
    queryKey: keys.worktreeOperation(projectId, worktreeId),
    queryFn: () => api.worktrees.operation({ projectId, worktreeId }),
    meta: { errorTitle: "Couldn't read the git state" },
  });
}

export function useResolveConflict() {
  return useWorkingTreeMutation<
    Scope & { path: string; side: "mine" | "theirs" },
    Worktree
  >(
    (api, input) => api.worktrees.resolveConflict(input),
    (worktree) => worktree,
    "Couldn't resolve the conflict",
  );
}

export function useContinueOperation() {
  return useWorkingTreeMutation<Scope, Worktree>(
    (api, input) => api.worktrees.continueOperation(input),
    (worktree) => worktree,
    "Couldn't continue",
  );
}

export function useAbortOperation() {
  return useWorkingTreeMutation<Scope, Worktree>(
    (api, input) => api.worktrees.abortOperation(input),
    (worktree) => worktree,
    "Couldn't abort",
  );
}

// How the worktree's branch and `ref` stand, for the merge dialog. A
// ref that names nothing is the dialog's to say, not a toast's.
export function useMergePreview(worktree: Worktree, ref: string) {
  const { api, keys } = useHostScope();
  const { projectId, id: worktreeId } = worktree;
  return useQuery<MergePreview>({
    queryKey: keys.mergePreview(
      projectId,
      worktreeId,
      ref,
      worktree.recentCommits[0]?.hash,
    ),
    queryFn: ref
      ? () => api.worktrees.mergePreview({ projectId, worktreeId, ref })
      : skipToken,
    retry: false,
    meta: { silentError: true },
  });
}

// The dialog says a failure in place, so no toast. A failure can leave
// the branch moved too (a squash whose commit a hook refused), so the
// worktree is read again either way.
export function useMergeBranch() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<
    MergeBranchResult,
    Error,
    Scope & { ref: string; method: IntegrateMethod; message?: string }
  >({
    mutationFn: (input) => api.worktrees.mergeBranch(input),
    onSuccess: (data, vars) =>
      invalidateWorkingTree(queryClient, keys, vars, data.worktree),
    onError: (_err, vars) => {
      void queryClient.invalidateQueries({
        queryKey: keys.worktrees(vars.projectId),
      });
      invalidateTreeState(queryClient, keys, vars);
    },
    meta: { silentError: true },
  });
}
