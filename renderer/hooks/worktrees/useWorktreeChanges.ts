import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { changeKey } from "@shared/schemas";
import type {
  ChangedFile,
  CommitChangesResult,
  CommitMessage,
  DiscardChangesResult,
  ResetSoftResult,
  Worktree,
} from "@shared/schemas";
import { clearCommitDraft } from "@/lib/commitDraft";
import { queryKeys } from "@/lib/queryKeys";

// Every changed file: what it is, how much of it is staged, and its
// +/- counts. The changes page draws its whole list from this, and
// fetches a diff only for the file it has picked -- so a tick refreshes
// the list and nothing else has to be kept in step with it.
export function useWorktreeChanges(
  projectId: string,
  worktreeId: string | undefined,
) {
  return useQuery<ChangedFile[]>({
    queryKey: queryKeys.worktreeChanges(projectId, worktreeId),
    queryFn: () => {
      if (!worktreeId) return [];
      return window.api.worktrees.changeStatus({ projectId, worktreeId });
    },
    enabled: !!worktreeId,
    // Same reasoning as the diff: the index is shared with every terminal
    // open on the worktree, so re-entering the page must re-read it.
    staleTime: 0,
    meta: { errorTitle: "Couldn't read change status" },
  });
}

interface SetStagedInput {
  projectId: string;
  worktreeId: string;
  paths: string[];
  staged: boolean;
}

// Tick/untick. Optimistic: the checkbox flips before git answers, and
// the status the call answers with is what makes a partial file settle
// to "all" -- one round trip, no refetch.
export function useSetStaged() {
  const queryClient = useQueryClient();
  return useMutation<ChangedFile[], Error, SetStagedInput>({
    mutationFn: (input) => window.api.worktrees.setStaged(input),
    onMutate: async (vars) => {
      const key = queryKeys.worktreeChanges(vars.projectId, vars.worktreeId);
      await queryClient.cancelQueries({ queryKey: key });
      const paths = new Set(vars.paths);
      queryClient.setQueryData<ChangedFile[]>(key, (current) =>
        current?.map((file) =>
          paths.has(file.path)
            ? { ...file, staged: vars.staged ? "all" : "none" }
            : file,
        ),
      );
    },
    onSuccess: (files, vars) => {
      const key = queryKeys.worktreeChanges(vars.projectId, vars.worktreeId);
      // The answer comes back without counts -- staging can't change
      // them, and reading every new file's lines again on each tick is
      // what that would cost. Carry over the ones already on screen; a
      // file this tick is the first to hear about shows none until the
      // next full read, which is a number missing for a moment rather
      // than a row that misbehaves.
      const carried = new Map(
        queryClient
          .getQueryData<ChangedFile[]>(key)
          ?.map((file) => [changeKey(file), file.counts]),
      );
      queryClient.setQueryData(
        key,
        files.map((file) => {
          const counts = carried.get(changeKey(file));
          return counts ? { ...file, counts } : file;
        }),
      );
    },
    onError: (_err, vars) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktreeChanges(vars.projectId, vars.worktreeId),
      });
    },
    meta: { errorTitle: "Couldn't update the selection" },
  });
}

// Everything derived from the working tree: the sidebar's count and
// recent commits, the patch, and the per-file index state.
function invalidateWorkingTree(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  worktreeId: string,
  worktree: Worktree,
): void {
  queryClient.setQueryData<Worktree[]>(queryKeys.worktrees(projectId), (list) =>
    list?.map((w) => (w.id === worktree.id ? worktree : w)),
  );
  void queryClient.invalidateQueries({
    queryKey: queryKeys.worktreeDiff(projectId, worktreeId),
  });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.worktreeChanges(projectId, worktreeId),
  });
}

interface CommitInput {
  projectId: string;
  worktreeId: string;
  summary: string;
  description?: string;
  stagePaths?: string[];
  amend?: boolean;
}

export function useCommitChanges() {
  const queryClient = useQueryClient();
  return useMutation<CommitChangesResult, Error, CommitInput>({
    mutationFn: (input) => window.api.worktrees.commit(input),
    onSuccess: (data, vars) => {
      // The page empties its own draft state. This covers the stored
      // copy when the page was left before the commit landed.
      clearCommitDraft(vars.projectId, vars.worktreeId);
      invalidateWorkingTree(
        queryClient,
        vars.projectId,
        vars.worktreeId,
        data.worktree,
      );
    },
    // A commit-all stages everything before git can refuse (a hook, no
    // identity), so the ticks have to be re-read either way.
    onError: (_err, vars) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktreeChanges(vars.projectId, vars.worktreeId),
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
  const queryClient = useQueryClient();
  return useMutation<DiscardChangesResult, Error, DiscardInput>({
    mutationFn: (input) => window.api.worktrees.discardChanges(input),
    onSuccess: (data, vars) =>
      invalidateWorkingTree(
        queryClient,
        vars.projectId,
        vars.worktreeId,
        data.worktree,
      ),
    meta: { errorTitle: "Couldn't discard changes" },
  });
}

interface RestoreDiscardInput {
  projectId: string;
  worktreeId: string;
  snapshot: string;
}

export function useRestoreDiscard() {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, RestoreDiscardInput>({
    mutationFn: (input) => window.api.worktrees.restoreDiscard(input),
    onSuccess: (worktree, vars) =>
      invalidateWorkingTree(
        queryClient,
        vars.projectId,
        vars.worktreeId,
        worktree,
      ),
    meta: { errorTitle: "Couldn't restore the discarded changes" },
  });
}

// The message of one commit, for prefilling an amend. Immutable per
// hash, like the commit diff. Exposed as options: the page fetches it
// on the Amend click rather than observing it.
export function commitMessageQueryOptions(
  projectId: string,
  worktreeId: string,
  hash: string,
) {
  return queryOptions<CommitMessage>({
    queryKey: queryKeys.commitMessage(projectId, worktreeId, hash),
    queryFn: () =>
      window.api.worktrees.commitMessage({ projectId, worktreeId, hash }),
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
  const queryClient = useQueryClient();
  return useMutation<ResetSoftResult, Error, ResetSoftInput>({
    mutationFn: (input) => window.api.worktrees.resetSoft(input),
    onSuccess: (data, vars) =>
      invalidateWorkingTree(
        queryClient,
        vars.projectId,
        vars.worktreeId,
        data.worktree,
      ),
    meta: { errorTitle: "Couldn't undo the commit" },
  });
}
