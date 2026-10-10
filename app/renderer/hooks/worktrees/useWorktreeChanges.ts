import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  skipToken,
} from "@tanstack/react-query";
import type {
  ChangedFile,
  CommitChangesResult,
  CommitPicks,
  FileHunks,
  CommitMessage,
  DiscardChangesResult,
  LineChange,
  ResetSoftResult,
  Worktree,
} from "@shigomori/contracts/schemas";
import {
  useHostScope,
  type HostApi,
  type HostScope,
} from "@/hooks/remote/useHostScope";
import { clearCommitDraft } from "@/lib/commitDraft";
import { useRegistry } from "@/lib/runtime/viewHooks";
import { writeBackWorktree } from "@/hooks/worktrees/useWorktrees";
import type { QueryKeyRegistry } from "@/lib/queryKeys";

// Every changed file: what it is, how much of it is staged, and its
// +/- counts. The changes page draws its whole list from this and
// fetches a diff only for the picked file.
export function useWorktreeChanges(
  projectId: string,
  worktreeId: string | undefined,
  // A preview (the transplant review's file list) reads the list once;
  // the changes page itself keeps the default focus refetch so it
  // tracks the working tree.
  options: { refetchOnWindowFocus?: boolean } = {},
) {
  const { api, keys } = useHostScope();
  return useQuery<readonly ChangedFile[]>({
    queryKey: keys.worktreeChanges(projectId, worktreeId),
    queryFn: worktreeId
      ? () => api.worktrees.changeStatus({ projectId, worktreeId })
      : skipToken,
    refetchOnWindowFocus: options.refetchOnWindowFocus,
    // Same reasoning as the diff: the index is shared with every terminal
    // open on the worktree, so re-entering the page must re-read it.
    staleTime: 0,
    meta: { errorTitle: "Couldn't read change status" },
  });
}

// One modified file's hunks, to tick one at a time. Off for anything
// else (an untracked, deleted, renamed or conflicted file),
// which only ticks whole.
export function useFileHunks(
  projectId: string,
  worktreeId: string,
  path: string | undefined,
) {
  const { api, keys } = useHostScope();
  return useQuery<FileHunks>({
    queryKey: keys.worktreeFileHunks(projectId, worktreeId, path ?? ""),
    queryFn: path
      ? () => api.worktrees.fileHunks({ projectId, worktreeId, path })
      : skipToken,
    staleTime: 0,
    meta: { errorTitle: "Couldn't read the file's hunks" },
  });
}

export function useDiscardHunks() {
  return useWorkingTreeMutation<
    {
      projectId: string;
      worktreeId: string;
      path: string;
      changes: LineChange[];
    },
    DiscardChangesResult
  >(
    (api, input) => api.worktrees.discardHunks(input),
    (data) => data.worktree,
    "Couldn't discard the change",
  );
}

// Everything derived from the working tree: the patch, the per-file
// index state, and the operation it may be stopped in.
export function invalidateTreeState(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: QueryKeyRegistry,
  { projectId, worktreeId }: { projectId: string; worktreeId: string },
): void {
  for (const queryKey of [
    keys.worktreeDiff(projectId, worktreeId),
    keys.worktreeChanges(projectId, worktreeId),
    keys.worktreeOperation(projectId, worktreeId),
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

// That, and the worktree the call answered with written back into its
// list, for the sidebar's count and recent commits.
export function useWorkingTreeWriteBack() {
  const queryClient = useQueryClient();
  const registry = useRegistry();
  const { deviceId, keys } = useHostScope();
  return (
    scope: { projectId: string; worktreeId: string },
    worktree: Worktree,
  ): void => {
    writeBackWorktree(registry, deviceId, worktree);
    invalidateTreeState(queryClient, keys, scope);
  };
}

// Discard, restore and undo share one shape: call the api, then write
// back the worktree the call answers with and refresh the working tree.
export function useWorkingTreeMutation<
  Input extends { projectId: string; worktreeId: string },
  Result,
>(
  call: (api: HostApi, input: Input) => Promise<Result>,
  worktreeOf: (result: Result) => Worktree,
  errorTitle: string,
) {
  const { api } = useHostScope();
  const writeBack = useWorkingTreeWriteBack();
  return useMutation<Result, Error, Input>({
    mutationFn: (input) => call(api, input),
    onSuccess: (data, vars) => writeBack(vars, worktreeOf(data)),
    meta: { errorTitle },
  });
}

interface CommitInput extends CommitPicks {
  projectId: string;
  worktreeId: string;
  // Absent for an amend that keeps HEAD's message.
  summary?: string;
  description?: string;
  amend?: boolean;
}

export function useCommitChanges() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  const writeBack = useWorkingTreeWriteBack();
  return useMutation<CommitChangesResult, Error, CommitInput>({
    mutationFn: (input) => api.worktrees.commit(input),
    onSuccess: (data, vars) => {
      // The page empties its own draft state. This covers the stored
      // copy when the page was left before the commit landed. A commit
      // that kept HEAD's message never used the draft.
      if (vars.summary !== undefined) {
        clearCommitDraft(vars.projectId, vars.worktreeId);
      }
      writeBack(vars, data.worktree);
    },
    // The index is set to the picks before git can refuse (a hook, no
    // identity), and the status says what is in it, so it is re-read.
    onError: (_err, vars) => {
      void queryClient.invalidateQueries({
        queryKey: keys.worktreeChanges(vars.projectId, vars.worktreeId),
      });
    },
    // The composer shows the failure (hook output, identity errors) in
    // place, where it can be read and selected. A toast would truncate it.
    meta: { silentError: true },
  });
}

interface DiscardInput {
  projectId: string;
  worktreeId: string;
  paths: string[];
}

export function useDiscardChanges() {
  return useWorkingTreeMutation<DiscardInput, DiscardChangesResult>(
    (api, input) => api.worktrees.discardChanges(input),
    (data) => data.worktree,
    "Couldn't discard changes",
  );
}

interface RestoreDiscardInput {
  projectId: string;
  worktreeId: string;
  snapshot: string;
}

export function useRestoreDiscard() {
  return useWorkingTreeMutation<RestoreDiscardInput, Worktree>(
    (api, input) => api.worktrees.restoreDiscard(input),
    (worktree) => worktree,
    "Couldn't restore the discarded changes",
  );
}

// The message of one commit, for prefilling an amend. Immutable per
// hash, like the commit diff. Exposed as options so the caller can add
// its own `enabled`. Not a hook, so the scope (which device's api and
// keys) comes in from the caller.
export function commitMessageQueryOptions(
  { api, keys }: Pick<HostScope, "api" | "keys">,
  projectId: string,
  worktreeId: string,
  hash: string,
) {
  return queryOptions<CommitMessage>({
    queryKey: keys.commitMessage(projectId, worktreeId, hash),
    queryFn: () => api.worktrees.commitMessage({ projectId, worktreeId, hash }),
    staleTime: Infinity,
    meta: { errorTitle: "Couldn't read the last commit's message" },
  });
}

interface ResetSoftInput {
  projectId: string;
  worktreeId: string;
  target: string;
  expectHead?: string;
}

// Undo (and redo) of commits. Both end in the same place: HEAD moved,
// index and working tree as they were, so the same refresh covers it.
export function useResetSoft() {
  return useWorkingTreeMutation<ResetSoftInput, ResetSoftResult>(
    (api, input) => api.worktrees.resetSoft(input),
    (data) => data.worktree,
    "Couldn't undo the commit",
  );
}
