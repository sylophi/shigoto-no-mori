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
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { useScriptRuns } from "@/hooks/scripts/useScriptRuns";

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
// Splitting it this way keeps the create itself on the bundled CLI.
// Only the ref resolution is PR-aware. The branch survives a failed
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
  const scriptRuns = useScriptRuns();
  return useMutation<CreateWorktreeResult, Error, ConvertExternalWorktreeInput>(
    {
      mutationFn: (input) => api.worktrees.convertExternal(input),
      onSuccess: (_result, vars) => {
        void queryClient.invalidateQueries({
          queryKey: keys.worktrees(vars.projectId),
        });
        // The old external worktree's id no longer maps to anything on
        // disk. Drop any cached script runs so they don't linger in the
        // UI.
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
  const scriptRuns = useScriptRuns();
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

// What the renderer does once a worktree is gone from disk: drop it
// from the cached list synchronously (consumers routing off the back
// of the mutation must not read the stale list during the refetch),
// clear its script runs, and remove its no-longer-observed queries so
// nothing can refetch or replay them. Shared by the delete and by a
// mirror stop, which removes the copy the same way.
export function useForgetDeletedWorktree() {
  const queryClient = useQueryClient();
  const { deviceId, keys } = useHostScope();
  const scriptRuns = useScriptRuns();
  return (projectId: string, worktreeId: string) => {
    queryClient.setQueryData<Worktree[]>(keys.worktrees(projectId), (current) =>
      current ? current.filter((w) => w.id !== worktreeId) : current,
    );
    void queryClient.invalidateQueries({
      queryKey: keys.worktrees(projectId),
    });
    scriptRuns.clearForWorktree(worktreeId);
    // Same treatment as project removal. Active queries (the detail
    // route unmounts only after the post-delete navigation) are left
    // to go inactive and gc naturally.
    queryClient.removeQueries({
      type: "inactive",
      predicate: (query) =>
        hostKeyDeviceId(query.queryKey) === deviceId &&
        query.queryKey.includes(worktreeId),
    });
  };
}

export function useDeleteWorktree() {
  const queryClient = useQueryClient();
  const { api, deviceId } = useHostScope();
  const forget = useForgetDeletedWorktree();
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
      // Only when the worktree was actually removed. Cleanup failures
      // keep the worktree around for retry.
      if (data.ok) forget(vars.projectId, vars.worktreeId);
    },
    // The detail page swaps into a force-delete prompt on failure, so a
    // toast on top would be noise.
    meta: { silentError: true },
  });
}

// `deviceId` names the peer a remote sidebar row belongs to. Absent,
// it is the surrounding scope's device (this machine with no provider).
export function useIsDeletingWorktree(
  worktreeId: string,
  deviceId?: string,
): boolean {
  const scope = useHostScope();
  return (
    useIsMutating({
      mutationKey: deleteWorktreeMutationKey(deviceId ?? scope.deviceId),
      predicate: (m) =>
        (m.state.variables as DeleteWorktreeInput | undefined)?.worktreeId ===
        worktreeId,
    }) > 0
  );
}

// The two per-worktree flags (shelf, auto-pull) share one mutation
// shape: an optimistic flip so the row and the sidebar group update
// before the IPC round-trip lands, then a splice of the server's row
// instead of a refetch of the whole project's list (the handler
// already returns the refreshed Worktree, so cache state stays
// accurate without an N-git-call round trip), and a rollback to truth
// on error.
function useSetWorktreeFlag<K extends "shelved" | "autoPull">(
  field: K,
  call: (
    api: HostApi,
    input: { projectId: string; worktreeId: string } & Record<K, boolean>,
  ) => Promise<Worktree>,
  errorTitle: string,
  onSettled?: (
    api: HostApi,
    input: { projectId: string; worktreeId: string } & Record<K, boolean>,
  ) => void,
) {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<
    Worktree,
    Error,
    { projectId: string; worktreeId: string } & Record<K, boolean>
  >({
    mutationFn: (input) => call(api, input),
    onMutate: (vars) => {
      queryClient.setQueryData<Worktree[]>(
        keys.worktrees(vars.projectId),
        (current) =>
          current
            ? current.map((w) =>
                w.id === vars.worktreeId ? { ...w, [field]: vars[field] } : w,
              )
            : current,
      );
    },
    onSuccess: (data, vars) => {
      queryClient.setQueryData<Worktree[]>(
        keys.worktrees(vars.projectId),
        (current) => current?.map((w) => (w.id === data.id ? data : w)),
      );
      onSettled?.(api, vars);
    },
    onError: (_err, vars) => {
      void queryClient.invalidateQueries({
        queryKey: keys.worktrees(vars.projectId),
      });
    },
    meta: { errorTitle },
  });
}

export function useSetShelved() {
  return useSetWorktreeFlag(
    "shelved",
    (api, input) => api.worktrees.setShelved(input),
    "Couldn't update shelved state",
  );
}

// Marking a worktree is followed by a project refresh: its auto-pull
// pass fast-forwards the newly marked worktree right away when it
// qualifies (instead of on the minute sweep), and announces the change
// to every row and viewer the way any pull does. Fire and forget: the
// mark itself already landed, and the fetch path reports its own
// failures.
export function useSetAutoPull() {
  return useSetWorktreeFlag(
    "autoPull",
    (api, input) => api.worktrees.setAutoPull(input),
    "Couldn't update auto-pull",
    (api, input) => {
      if (input.autoPull) void api.git.refreshProject(input.projectId);
    },
  );
}
