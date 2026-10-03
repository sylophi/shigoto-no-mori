import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import {
  useOverwriteWorktree,
  usePublishWorktree,
  usePullAndPushWorktree,
  usePullWorktree,
  usePushForceWorktree,
  usePushWorktree,
} from "@/hooks/worktrees/useWorktreeSync";
import { deriveRemoteSyncState, type Worktree } from "@shared/schemas";
import { WorktreeSyncPillView } from "./WorktreeSyncPillView";

interface WorktreeSyncPillProps {
  worktree: Worktree;
}

// Renders the remote-sync action(s) for a worktree. Returns null in the
// states where there's nothing to show (synced, detached) so the header
// stays quiet. The caller takes care of the dirty-state pill, which is
// mutually exclusive with this one.
export function WorktreeSyncPill({ worktree }: WorktreeSyncPillProps) {
  const state = deriveRemoteSyncState(worktree);
  const input = { projectId: worktree.projectId, worktreeId: worktree.id };

  const push = usePushWorktree();
  const pull = usePullWorktree();
  const pushForce = usePushForceWorktree();
  const overwrite = useOverwriteWorktree();
  const publish = usePublishWorktree();
  const pullAndPush = usePullAndPushWorktree();
  // Both diverged actions throw away one side's commits, which is more
  // destructive than "Delete worktree" (that one keeps the branch). Same
  // two-step confirm, and arming one disarms the other so a stray second
  // click can't land on the button the user didn't mean.
  const confirmPushForce = useConfirmTwice(CONFIRM_QUICK_MS);
  const confirmOverwrite = useConfirmTwice(CONFIRM_QUICK_MS);

  return (
    <WorktreeSyncPillView
      state={state}
      autoPull={worktree.autoPull}
      pending={{
        publish: publish.isPending,
        push: push.isPending,
        pull: pull.isPending,
        pullAndPush: pullAndPush.isPending,
        pushForce: pushForce.isPending,
        overwrite: overwrite.isPending,
      }}
      armed={{
        pushForce: confirmPushForce.armed,
        overwrite: confirmOverwrite.armed,
      }}
      on={{
        publish: () => publish.mutate(input),
        push: () => push.mutate(input),
        pull: () => pull.mutate(input),
        pullAndPush: () => pullAndPush.mutate(input),
        pushForce: () => {
          confirmOverwrite.reset();
          confirmPushForce.trigger(() => pushForce.mutate(input));
        },
        overwrite: () => {
          confirmPushForce.reset();
          confirmOverwrite.trigger(() => overwrite.mutate(input));
        },
      }}
    />
  );
}
