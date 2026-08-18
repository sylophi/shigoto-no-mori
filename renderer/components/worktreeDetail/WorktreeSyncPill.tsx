import { ArrowDown, ArrowUp, CloudUpload } from "lucide-react";
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
import { commitsLabel } from "./commitsLabel";
import { SyncActionButton } from "./SyncActionButton";

interface WorktreeSyncPillProps {
  worktree: Worktree;
}

// Renders the remote-sync action(s) for a worktree. Returns null in the
// states where there's nothing to show (synced, detached) so the header
// stays quiet -- the caller takes care of the dirty-state pill, which is
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

  if (state.kind === "detached" || state.kind === "synced") return null;

  if (state.kind === "publish") {
    return (
      <SyncActionButton
        tone="violet"
        icon={CloudUpload}
        label="Publish branch"
        title={
          state.canPublish
            ? "Push branch to remote with upstream tracking"
            : "No git remote is configured for this project"
        }
        disabled={!state.canPublish}
        pending={publish.isPending}
        onClick={() => publish.mutate(input)}
      />
    );
  }

  if (state.kind === "ahead") {
    return (
      <SyncActionButton
        tone="emerald"
        icon={ArrowUp}
        label={`Push ${commitsLabel(state.ahead)}`}
        title="git push"
        pending={push.isPending}
        onClick={() => push.mutate(input)}
      />
    );
  }

  if (state.kind === "behind") {
    return (
      <SyncActionButton
        tone="sky"
        icon={ArrowDown}
        label={`Pull ${commitsLabel(state.behind)}`}
        title="git pull --ff-only"
        pending={pull.isPending}
        onClick={() => pull.mutate(input)}
      />
    );
  }

  if (state.kind === "pullAndPush") {
    return (
      <SyncActionButton
        tone="indigo"
        label={`Pull and push ↑${state.ahead}↓${state.behind}`}
        title="git pull --rebase, falling back to a merge on conflict, then git push"
        pending={pullAndPush.isPending}
        onClick={() => pullAndPush.mutate(input)}
      />
    );
  }

  // Histories have truly diverged. The only moves left are "overwrite the
  // remote" (force-push) or "overwrite local" (reset hard), both behind a
  // two-step confirm.
  // pull --rebase would almost certainly fail mid-flight here, so we don't
  // offer it -- the user picks which side wins.
  const busy = pushForce.isPending || overwrite.isPending;
  return (
    <span
      title={`Diverged: ${state.ahead} local, ${state.behind} remote. History has split -- pick which side wins.`}
      className="inline-flex shrink-0 items-center gap-1 self-center text-xs"
    >
      <span className="px-1.5 text-rose-500">Overwrite:</span>
      <SyncActionButton
        tone="rose"
        icon={ArrowUp}
        label={confirmPushForce.armed ? "Confirm?" : `Push ${state.ahead}`}
        title={
          confirmPushForce.armed
            ? "Click again to confirm"
            : "git push --force-with-lease -- overwrites the remote"
        }
        pending={pushForce.isPending}
        disabled={busy}
        onClick={() => {
          confirmOverwrite.reset();
          confirmPushForce.trigger(() => pushForce.mutate(input));
        }}
      />
      <SyncActionButton
        tone="rose"
        icon={ArrowDown}
        label={confirmOverwrite.armed ? "Confirm?" : `Pull ${state.behind}`}
        title={
          confirmOverwrite.armed
            ? "Click again to confirm"
            : "git fetch && git reset --hard @{u} -- overwrites local"
        }
        pending={overwrite.isPending}
        disabled={busy}
        onClick={() => {
          confirmPushForce.reset();
          confirmOverwrite.trigger(() => overwrite.mutate(input));
        }}
      />
    </span>
  );
}
