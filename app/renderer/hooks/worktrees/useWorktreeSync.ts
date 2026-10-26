import { useMutation, useMutationState } from "@tanstack/react-query";
import type { MergeBranchResult, Worktree } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { notifyError } from "@/lib/toast";
import { isSyncConflictsError } from "@shigomori/contracts/errors";
import { useWorkingTreeWriteBack } from "./useWorktreeChanges";
import type { SyncMove } from "@shigomori/ui/lib/syncState.ts";

interface SyncWorktreeInput {
  projectId: string;
  worktreeId: string;
}

// The moves that resolve to the refreshed Worktree, and the two that
// merge keeping their conflicts, by their methods on `api.worktrees`.
type WorktreeMove =
  | "push"
  | "pull"
  | "pushForce"
  | "overwrite"
  | "publish"
  | "pullAndPush"
  | "syncWithPrimary";
type MergeMove = "mergeUpstream" | "mergePrimary";
export type RunningSync = WorktreeMove | MergeMove;

// The syncs this window has under way on a device, each keyed by its
// move, so every surface showing a worktree sees one running whichever
// started it (the pill a push from ⌘↩ or the palette).
const syncKey = (deviceId: string, move?: RunningSync) =>
  move === undefined
    ? ["sync-worktree", deviceId]
    : ["sync-worktree", deviceId, move];

// Only this window's: a sync from another window or the CLI shows once
// the worktree's row changes.
export function useRunningSyncs(worktree: Worktree): RunningSync[] {
  const { deviceId } = useHostScope();
  return useMutationState({
    filters: {
      mutationKey: syncKey(deviceId),
      status: "pending",
      predicate: (mutation) =>
        (mutation.state.variables as SyncWorktreeInput | undefined)
          ?.worktreeId === worktree.id,
    },
    select: (mutation) => mutation.options.mutationKey?.[2] as RunningSync,
  });
}

// Shared shape for the remote-sync family (push, pull, force-push,
// overwrite, publish, pull-and-push). Every one resolves to the
// refreshed Worktree and only differs in the API method + error title.
function useSyncMutation(
  move: WorktreeMove,
  errorTitle: string,
  // Reports failures itself rather than by the shared toast. Here, on
  // the hook, so a failure is said even once the caller has unmounted.
  onError?: (err: Error) => void,
) {
  const { api, deviceId } = useHostScope();
  const writeBack = useWorkingTreeWriteBack();
  return useMutation<Worktree, Error, SyncWorktreeInput>({
    mutationKey: syncKey(deviceId, move),
    mutationFn: (input) => api.run(api.worktrees[move](input)),
    // Pull, overwrite and sync rewrite the working tree, so an open
    // changes page has to re-read its patch and its checkbox states. PR
    // queries refresh via the refs-changed broadcast that the push
    // itself triggers, so no PR invalidation is needed here.
    onSuccess: (data, vars) => writeBack(vars, data),
    onError,
    meta: onError ? { silentError: true } : { errorTitle },
  });
}

const usePushWorktree = () => useSyncMutation("push", "Couldn't push");
const usePullWorktree = () => useSyncMutation("pull", "Couldn't pull");
export const usePushForceWorktree = () =>
  useSyncMutation("pushForce", "Couldn't force-push");
export const useOverwriteWorktree = () =>
  useSyncMutation("overwrite", "Couldn't overwrite from upstream");
const usePublishWorktree = () =>
  useSyncMutation("publish", "Couldn't publish branch");
const usePullAndPushWorktree = () =>
  useSyncMutation("pullAndPush", "Couldn't pull and push");
// A conflict is the pill's to say, with its way on. Anything else is
// said here.
export const useSyncWithPrimaryWorktree = () =>
  useSyncMutation("syncWithPrimary", "Couldn't sync from primary", (err) => {
    if (!isSyncConflictsError(err)) {
      notifyError("Couldn't sync from primary", err);
    }
  });
// A sync that conflicts, from the upstream or the primary branch,
// merged anyway and stopped on its conflicts.
function useMergeKeepingConflicts(move: MergeMove, errorTitle: string) {
  const { api, deviceId } = useHostScope();
  const writeBack = useWorkingTreeWriteBack();
  return useMutation<MergeBranchResult, Error, SyncWorktreeInput>({
    mutationKey: syncKey(deviceId, move),
    mutationFn: (input) => api.run(api.worktrees[move](input)),
    onSuccess: (data, vars) => writeBack(vars, data.worktree),
    meta: { errorTitle },
  });
}

export const useMergeUpstreamWorktree = () =>
  useMergeKeepingConflicts("mergeUpstream", "Couldn't merge");
export const useMergePrimaryWorktree = () =>
  useMergeKeepingConflicts("mergePrimary", "Couldn't merge from primary");

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
