import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CreateWorktreeResult,
  DeleteWorktreeResult,
  Worktree,
} from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";
import { scriptRuns } from "@/store/scriptRuns";

interface CreateWorktreeInput {
  projectId: string;
  worktreeName?: string;
  branchName?: string;
  base?: string;
  checkout?: boolean;
}

export function useCreateWorktree() {
  const queryClient = useQueryClient();
  return useMutation<CreateWorktreeResult, Error, CreateWorktreeInput>({
    mutationFn: (input) => window.api.worktrees.create(input),
    onSuccess: (_result, vars) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktrees(vars.projectId),
      });
    },
    meta: { errorTitle: "Couldn't create worktree" },
  });
}

interface ConvertExternalWorktreeInput {
  projectId: string;
  worktreeId: string;
}

export function useConvertExternalWorktree() {
  const queryClient = useQueryClient();
  return useMutation<CreateWorktreeResult, Error, ConvertExternalWorktreeInput>(
    {
      mutationFn: (input) => window.api.worktrees.convertExternal(input),
      onSuccess: (_result, vars) => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.worktrees(vars.projectId),
        });
        // The old external worktree's id no longer maps to anything on disk
        // -- drop any cached script runs so they don't linger in the UI.
        scriptRuns.clearForWorktree(vars.worktreeId);
      },
      // The page surfaces per-row errors inline; a toast on top would be noise.
      meta: { silentError: true },
    },
  );
}

interface RelocateWorktreeInput {
  projectId: string;
  worktreeId: string;
  destinationPath: string;
}

export function useRelocateWorktree() {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, RelocateWorktreeInput>({
    mutationFn: (input) => window.api.worktrees.relocate(input),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktrees(vars.projectId),
      });
      // The relocated worktree's id changes (it's derived from path), so
      // any cached script runs keyed by the pre-move id are stranded.
      scriptRuns.clearForWorktree(vars.worktreeId);
    },
    // The page surfaces per-row errors inline; a toast on top would be noise.
    meta: { silentError: true },
  });
}

interface DeleteWorktreeInput {
  projectId: string;
  worktreeId: string;
  force?: boolean;
  skipCleanup?: boolean;
}

const DELETE_WORKTREE_MUTATION_KEY = ["delete-worktree"] as const;

export function useDeleteWorktree() {
  const queryClient = useQueryClient();
  return useMutation<DeleteWorktreeResult, Error, DeleteWorktreeInput>({
    mutationKey: DELETE_WORKTREE_MUTATION_KEY,
    mutationFn: (input) => window.api.worktrees.delete(input),
    onSuccess: (data, vars) => {
      // Only invalidate + clear runs when the worktree was actually
      // removed. Cleanup failures keep the worktree around for retry.
      if (data.ok) {
        // Drop the deleted entry from cache synchronously so consumers
        // routing off the back of this mutation (e.g. EmptyState's
        // first-worktree resolver) don't read the stale list during the
        // invalidate's background refetch.
        queryClient.setQueryData<Worktree[]>(
          queryKeys.worktrees(vars.projectId),
          (current) =>
            current ? current.filter((w) => w.id !== vars.worktreeId) : current,
        );
        void queryClient.invalidateQueries({
          queryKey: queryKeys.worktrees(vars.projectId),
        });
        scriptRuns.clearForWorktree(vars.worktreeId);
      }
    },
    // The detail page swaps into a force-delete prompt on failure -- a
    // toast on top would be noise.
    meta: { silentError: true },
  });
}

export function useIsDeletingWorktree(worktreeId: string): boolean {
  return (
    useIsMutating({
      mutationKey: DELETE_WORKTREE_MUTATION_KEY,
      predicate: (m) =>
        (m.state.variables as DeleteWorktreeInput | undefined)?.worktreeId ===
        worktreeId,
    }) > 0
  );
}

interface SetShelvedInput {
  projectId: string;
  worktreeId: string;
  shelved: boolean;
}

export function useSetShelved() {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, SetShelvedInput>({
    mutationFn: (input) => window.api.worktrees.setShelved(input),
    onMutate: (vars) => {
      // Optimistic flip so the row's appearance and the sidebar group
      // both update before the IPC round-trip lands.
      queryClient.setQueryData<Worktree[]>(
        queryKeys.worktrees(vars.projectId),
        (current) =>
          current
            ? current.map((w) =>
                w.id === vars.worktreeId ? { ...w, shelved: vars.shelved } : w,
              )
            : current,
      );
    },
    onSuccess: (data, vars) => {
      // Splice in the server's row instead of refetching the whole
      // project's list. The handler already returns the refreshed
      // Worktree so cache state stays accurate without an N-git-call
      // round trip.
      queryClient.setQueryData<Worktree[]>(
        queryKeys.worktrees(vars.projectId),
        (current) => current?.map((w) => (w.id === data.id ? data : w)),
      );
    },
    onError: (_err, vars) => {
      // Roll the stuck-optimistic row back to truth.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktrees(vars.projectId),
      });
    },
    meta: { errorTitle: "Couldn't update shelved state" },
  });
}
