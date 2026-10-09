import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MergeBranchResult, Worktree } from "@shigomori/contracts/schemas";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { notifyError } from "@/lib/toast";
import { isSyncConflictsError } from "@shigomori/contracts/errors";
import { invalidateWorkingTree } from "./useWorktreeChanges";
import type { SyncMove } from "@/lib/syncState";

interface SyncWorktreeInput {
  projectId: string;
  worktreeId: string;
}

// Shared shape for the remote-sync family (push, pull, force-push,
// overwrite, publish, pull-and-push). Every one resolves to the
// refreshed Worktree and only differs in the API method + error title.
function useSyncMutation(
  apiMethod: (api: HostApi, input: SyncWorktreeInput) => Promise<Worktree>,
  errorTitle: string,
  // Reports failures itself rather than by the shared toast. Here, on
  // the hook, so a failure is said even once the caller has unmounted.
  onError?: (err: Error) => void,
) {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<Worktree, Error, SyncWorktreeInput>({
    mutationFn: (input) => apiMethod(api, input),
    // Pull, overwrite and sync rewrite the working tree, so an open
    // changes page has to re-read its patch and its checkbox states. PR
    // queries refresh via the refs-changed broadcast that the push
    // itself triggers, so no PR invalidation is needed here.
    onSuccess: (data, vars) =>
      invalidateWorkingTree(queryClient, keys, vars, data),
    onError,
    meta: onError ? { silentError: true } : { errorTitle },
  });
}

const usePushWorktree = () =>
  useSyncMutation((api, i) => api.worktrees.push(i), "Couldn't push");
const usePullWorktree = () =>
  useSyncMutation((api, i) => api.worktrees.pull(i), "Couldn't pull");
export const usePushForceWorktree = () =>
  useSyncMutation(
    (api, i) => api.worktrees.pushForce(i),
    "Couldn't force-push",
  );
export const useOverwriteWorktree = () =>
  useSyncMutation(
    (api, i) => api.worktrees.overwrite(i),
    "Couldn't overwrite from upstream",
  );
const usePublishWorktree = () =>
  useSyncMutation(
    (api, i) => api.worktrees.publish(i),
    "Couldn't publish branch",
  );
const usePullAndPushWorktree = () =>
  useSyncMutation(
    (api, i) => api.worktrees.pullAndPush(i),
    "Couldn't pull and push",
  );
// A conflict is the pill's to say, with its way on. Anything else is
// said here.
export const useSyncWithPrimaryWorktree = () =>
  useSyncMutation(
    (api, i) => api.worktrees.syncWithPrimary(i),
    "Couldn't sync from primary",
    (err) => {
      if (!isSyncConflictsError(err)) {
        notifyError("Couldn't sync from primary", err);
      }
    },
  );
// A sync that conflicts, from the upstream or the primary branch,
// merged anyway and stopped on its conflicts.
function useMergeKeepingConflicts(
  call: (api: HostApi, input: SyncWorktreeInput) => Promise<MergeBranchResult>,
  errorTitle: string,
) {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<MergeBranchResult, Error, SyncWorktreeInput>({
    mutationFn: (input) => call(api, input),
    onSuccess: (data, vars) =>
      invalidateWorkingTree(queryClient, keys, vars, data.worktree),
    meta: { errorTitle },
  });
}

export const useMergeUpstreamWorktree = () =>
  useMergeKeepingConflicts(
    (api, i) => api.worktrees.mergeUpstream(i),
    "Couldn't merge",
  );
export const useMergePrimaryWorktree = () =>
  useMergeKeepingConflicts(
    (api, i) => api.worktrees.mergePrimary(i),
    "Couldn't merge from primary",
  );

// The safe moves by their key (lib/syncState), for the pill and the
// palette, which run whichever one the view offers.
export function useSyncMoveMutations(): Record<
  SyncMove["key"],
  ReturnType<typeof useSyncMutation>
> {
  return {
    push: usePushWorktree(),
    pull: usePullWorktree(),
    publish: usePublishWorktree(),
    pullAndPush: usePullAndPushWorktree(),
  };
}
