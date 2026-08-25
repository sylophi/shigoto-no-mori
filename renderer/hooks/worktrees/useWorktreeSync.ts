import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Worktree } from "@shared/schemas";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";

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
) {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<Worktree, Error, SyncWorktreeInput>({
    mutationFn: (input) => apiMethod(api, input),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: keys.worktrees(vars.projectId),
      });
      // PR queries refresh via the refs-changed broadcast that the push
      // itself triggers, so no PR invalidation is needed here.
    },
    meta: { errorTitle },
  });
}

export const usePushWorktree = () =>
  useSyncMutation((api, i) => api.worktrees.push(i), "Couldn't push");
export const usePullWorktree = () =>
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
export const usePublishWorktree = () =>
  useSyncMutation(
    (api, i) => api.worktrees.publish(i),
    "Couldn't publish branch",
  );
export const usePullAndPushWorktree = () =>
  useSyncMutation(
    (api, i) => api.worktrees.pullAndPush(i),
    "Couldn't pull and push",
  );
export const useSyncWithPrimaryWorktree = () =>
  useSyncMutation(
    (api, i) => api.worktrees.syncWithPrimary(i),
    "Couldn't sync from primary",
  );
