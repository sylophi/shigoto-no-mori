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
import { hostKeyDeviceId } from "@/lib/queryKeys";
import { useHostScope } from "@/hooks/remote/useHostScope";
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
  const { api, keys } = useHostScope();
  return useMutation<CreateWorktreeResult, Error, CreateWorktreeInput>({
    mutationFn: (input) => api.worktrees.create(input),
    onSuccess: (_result, vars) => {
      void queryClient.invalidateQueries({
        queryKey: keys.worktrees(vars.projectId),
      });
    },
    meta: { errorTitle: "Couldn't create worktree" },
  });
}

interface CreateWorktreeFromPullRequestInput {
  projectId: string;
  worktreeName?: string;
  number: number;
}

// Two calls behind one mutation: land the PR head on a local branch,
// then create the worktree on it through the ordinary checkout path.
// Splitting it this way keeps the create itself on the bundled CLI --
// only the ref resolution is PR-aware. The branch survives a failed
// create, which is fine: it's the same branch `gh pr checkout` would
// have left, and a retry reuses it.
export function useCreateWorktreeFromPullRequest() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<
    CreateWorktreeResult,
    Error,
    CreateWorktreeFromPullRequestInput
  >({
    mutationFn: async ({ projectId, worktreeName, number }) => {
      const { branch } = await api.githubCli.resolvePullRequestCheckout({
        projectId,
        number,
      });
      return api.worktrees.create({
        projectId,
        worktreeName,
        base: branch,
        checkout: true,
      });
    },
    onSuccess: (_result, vars) => {
      void queryClient.invalidateQueries({
        queryKey: keys.worktrees(vars.projectId),
      });
      // The resolve step created a local branch, so the branch list and
      // the "already checked out" bookkeeping behind it are both stale.
      void queryClient.invalidateQueries({
        queryKey: keys.branches(vars.projectId),
      });
    },
    meta: { errorTitle: "Couldn't check out pull request" },
  });
}

interface ConvertExternalWorktreeInput {
  projectId: string;
  worktreeId: string;
}

export function useConvertExternalWorktree() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<CreateWorktreeResult, Error, ConvertExternalWorktreeInput>(
    {
      mutationFn: (input) => api.worktrees.convertExternal(input),
      onSuccess: (_result, vars) => {
        void queryClient.invalidateQueries({
          queryKey: keys.worktrees(vars.projectId),
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
  const { api, keys } = useHostScope();
  return useMutation<Worktree, Error, RelocateWorktreeInput>({
    mutationFn: (input) => api.worktrees.relocate(input),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: keys.worktrees(vars.projectId),
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

// Scoped by device: worktree ids are content hashes of the absolute
// path, so the same username and layout on two of the owner's machines
// yields colliding ids. An unscoped key would let a remote delete flip
// the local sidebar row of the same-named local worktree into its
// deleting state.
const deleteWorktreeMutationKey = (deviceId: string) =>
  ["delete-worktree", deviceId] as const;

export function useDeleteWorktree() {
  const queryClient = useQueryClient();
  const { api, deviceId, keys } = useHostScope();
  return useMutation<DeleteWorktreeResult, Error, DeleteWorktreeInput>({
    mutationKey: deleteWorktreeMutationKey(deviceId),
    mutationFn: (input) => api.worktrees.delete(input),
    onMutate: async (vars) => {
      // Cancel this worktree's in-flight fetches (a focus-triggered
      // diff/data refetch) before main starts removing it: left to
      // settle, they'd reject with "Unknown worktree" and toast, while
      // cancellation is swallowed silently. Gated on the scoped device
      // so another device's queries never match on a coincidentally
      // equal worktree id.
      await queryClient.cancelQueries({
        predicate: (query) =>
          hostKeyDeviceId(query.queryKey) === deviceId &&
          query.queryKey.includes(vars.worktreeId),
      });
    },
    onSuccess: (data, vars) => {
      // Only invalidate + clear runs when the worktree was actually
      // removed. Cleanup failures keep the worktree around for retry.
      if (data.ok) {
        // Drop the deleted entry from cache synchronously so consumers
        // routing off the back of this mutation (e.g. EmptyState's
        // first-worktree resolver) don't read the stale list during the
        // invalidate's background refetch.
        queryClient.setQueryData<Worktree[]>(
          keys.worktrees(vars.projectId),
          (current) =>
            current ? current.filter((w) => w.id !== vars.worktreeId) : current,
        );
        void queryClient.invalidateQueries({
          queryKey: keys.worktrees(vars.projectId),
        });
        scriptRuns.clearForWorktree(vars.worktreeId);
        // Same treatment as project removal: drop the deleted
        // worktree's no-longer-observed queries (worktree data, diff,
        // commits, ...) so nothing can refetch or replay them. Active
        // ones (the detail route unmounts only after the post-delete
        // navigation) are left to go inactive and gc naturally.
        queryClient.removeQueries({
          type: "inactive",
          predicate: (query) =>
            hostKeyDeviceId(query.queryKey) === deviceId &&
            query.queryKey.includes(vars.worktreeId),
        });
      }
    },
    // The detail page swaps into a force-delete prompt on failure -- a
    // toast on top would be noise.
    meta: { silentError: true },
  });
}

export function useIsDeletingWorktree(worktreeId: string): boolean {
  const { deviceId } = useHostScope();
  return (
    useIsMutating({
      mutationKey: deleteWorktreeMutationKey(deviceId),
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
  const { api, keys } = useHostScope();
  return useMutation<Worktree, Error, SetShelvedInput>({
    mutationFn: (input) => api.worktrees.setShelved(input),
    onMutate: (vars) => {
      // Optimistic flip so the row's appearance and the sidebar group
      // both update before the IPC round-trip lands.
      queryClient.setQueryData<Worktree[]>(
        keys.worktrees(vars.projectId),
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
        keys.worktrees(vars.projectId),
        (current) => current?.map((w) => (w.id === data.id ? data : w)),
      );
    },
    onError: (_err, vars) => {
      // Roll the stuck-optimistic row back to truth.
      void queryClient.invalidateQueries({
        queryKey: keys.worktrees(vars.projectId),
      });
    },
    meta: { errorTitle: "Couldn't update shelved state" },
  });
}
