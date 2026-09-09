import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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

// Index state per changed file, for the changes page's checkboxes. Kept
// apart from the patch query: a tick changes only this, and refetching
// a large patch on every checkbox would make the rail feel stuck.
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

// Whether two status lists describe the same set of files, ignoring how
// much of each is staged. `listChangedFiles` walks git's own output, so
// the same tree comes back in the same order; a false "no" here costs
// one refetch and nothing else.
function samePaths(
  before: readonly ChangedFile[] | undefined,
  after: readonly ChangedFile[],
): boolean {
  if (!before || before.length !== after.length) return false;
  return before.every(
    (file, i) =>
      file.path === after[i]?.path && file.prevPath === after[i]?.prevPath,
  );
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
      const before = queryClient.getQueryData<ChangedFile[]>(key);
      queryClient.setQueryData(key, files);
      // This answer is a fresher look at the tree than the patch beside
      // it was: anything written since the patch was fetched -- an agent
      // is usually running in these worktrees -- arrives here, and the
      // changes list would show a file the patch has nothing for, which
      // is a row you can tick but not read. Only when the set of files
      // moved: a tick that just flips index state is the common case and
      // must not drag a whole patch behind it.
      if (!samePaths(before, files)) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.worktreeDiff(vars.projectId, vars.worktreeId),
        });
      }
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
