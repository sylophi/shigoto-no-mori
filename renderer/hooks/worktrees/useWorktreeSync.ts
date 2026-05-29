import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Worktree } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

interface SyncWorktreeInput {
  projectId: string;
  worktreeId: string;
}

// Shared shape for the remote-sync family (push, pull, force-push,
// overwrite, publish, pull-and-push). Every one resolves to the
// refreshed Worktree and only differs in the API method + error title.
function useSyncMutation(
  apiMethod: (input: SyncWorktreeInput) => Promise<Worktree>,
  errorTitle: string,
) {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, SyncWorktreeInput>({
    mutationFn: apiMethod,
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktrees(vars.projectId),
      });
      // PR queries refresh via the refs-changed broadcast that the push
      // itself triggers, so no PR invalidation is needed here.
    },
    meta: { errorTitle },
  });
}

export const usePushWorktree = () =>
  useSyncMutation((i) => window.api.worktrees.push(i), "Couldn't push");
export const usePullWorktree = () =>
  useSyncMutation((i) => window.api.worktrees.pull(i), "Couldn't pull");
export const usePushForceWorktree = () =>
  useSyncMutation(
    (i) => window.api.worktrees.pushForce(i),
    "Couldn't force-push",
  );
export const useOverwriteWorktree = () =>
  useSyncMutation(
    (i) => window.api.worktrees.overwrite(i),
    "Couldn't overwrite from upstream",
  );
export const usePublishWorktree = () =>
  useSyncMutation(
    (i) => window.api.worktrees.publish(i),
    "Couldn't publish branch",
  );
export const usePullAndPushWorktree = () =>
  useSyncMutation(
    (i) => window.api.worktrees.pullAndPush(i),
    "Couldn't pull and push",
  );
export const useSyncWithPrimaryWorktree = () =>
  useSyncMutation(
    (i) => window.api.worktrees.syncWithPrimary(i),
    "Couldn't sync from primary",
  );
