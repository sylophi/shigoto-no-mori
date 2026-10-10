import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import {
  useMergeUpstreamWorktree,
  useOverwriteWorktree,
  usePushForceWorktree,
  useSyncMoveMutations,
} from "@/hooks/worktrees/useWorktreeSync";
import { worktreeSyncView } from "@shigomori/ui/lib/syncState.ts";
import type { Worktree } from "@shigomori/contracts/schemas";
import { assertNever } from "@shigomori/ui/lib/utils.ts";
import { SyncActionButtonView } from "@shigomori/ui/views/worktreeDetail/SyncActionButtonView.tsx";
import {
  HeldSyncView,
  PickSideView,
} from "@shigomori/ui/views/worktreeDetail/WorktreeSyncPillView.tsx";

interface WorktreeSyncPillProps {
  worktree: Worktree;
  // Short labels ("Push 2") for a narrow strip, the full sentence in
  // the tooltip instead.
  compact?: boolean;
}

// The remote-sync action(s) for a worktree, as lib/syncState says.
// None on a peer that takes no commands from here.
export function WorktreeSyncPill({
  worktree,
  compact = false,
}: WorktreeSyncPillProps) {
  const { state, move, held, waiting } = worktreeSyncView(worktree);
  const input = { projectId: worktree.projectId, worktreeId: worktree.id };
  const mutations = useSyncMoveMutations();
  // Held here, not in PickSide: a dirty tree swaps PickSide for the
  // held hint, and an overwrite still running must keep both buttons
  // disabled when it comes back.
  const pushForce = usePushForceWorktree();
  const overwrite = useOverwriteWorktree();
  const mergeUpstream = useMergeUpstreamWorktree();
  const { canCommand } = useCommandAccess();

  if (!canCommand) return null;
  if (waiting) {
    // Never the move while it waits.
    if (!held) return null;
    return <HeldSyncView held={held} compact={compact} />;
  }

  switch (state.kind) {
    case "detached":
    case "synced":
      return null;
    case "publish":
    case "ahead":
    case "behind":
    case "pullAndPush": {
      if (!move) return null;
      const mutation = mutations[move.key];
      return (
        <SyncActionButtonView
          tone={move.tone}
          icon={move.arrowsInLabel ? undefined : move.Icon}
          label={compact ? move.compactLabel : move.label}
          tip={move.disabledReason ?? move.tip}
          disabled={move.disabledReason !== undefined}
          pending={mutation.isPending}
          onClick={() => mutation.mutate(input)}
        />
      );
    }
    case "diverged":
      return (
        <PickSide
          worktree={worktree}
          pushForce={pushForce}
          overwrite={overwrite}
          mergeUpstream={mergeUpstream}
          ahead={state.ahead}
          behind={state.behind}
          compact={compact}
        />
      );
    default:
      return assertNever(state);
  }
}

function PickSide({
  worktree,
  pushForce,
  overwrite,
  mergeUpstream,
  ahead,
  behind,
  compact,
}: {
  worktree: Worktree;
  pushForce: ReturnType<typeof usePushForceWorktree>;
  overwrite: ReturnType<typeof useOverwriteWorktree>;
  mergeUpstream: ReturnType<typeof useMergeUpstreamWorktree>;
  ahead: number;
  behind: number;
  compact: boolean;
}) {
  const nav = useWorktreeNav();
  const say = useWorktreeSuccessToast();
  const input = { projectId: worktree.projectId, worktreeId: worktree.id };
  // Both actions throw away one side's commits, which is more
  // destructive than "Delete worktree" (that one keeps the branch). Same
  // two-step confirm, and arming one disarms the other so a stray second
  // click can't land on the button the user didn't mean.
  const confirmPushForce = useConfirmTwice(CONFIRM_QUICK_MS);
  const confirmOverwrite = useConfirmTwice(CONFIRM_QUICK_MS);
  return (
    <PickSideView
      ahead={ahead}
      behind={behind}
      compact={compact}
      busy={
        pushForce.isPending || overwrite.isPending || mergeUpstream.isPending
      }
      merge={{
        pending: mergeUpstream.isPending,
        onClick: () =>
          mergeUpstream.mutate(input, {
            onSuccess: ({ worktree: after, stopped }) => {
              if (stopped) nav.toDiff(input.projectId, input.worktreeId);
              else say(after, "Merged the remote's commits");
            },
          }),
      }}
      pushForce={{
        armed: confirmPushForce.armed,
        pending: pushForce.isPending,
        onClick: () => {
          confirmOverwrite.reset();
          confirmPushForce.trigger(() => pushForce.mutate(input));
        },
      }}
      overwrite={{
        armed: confirmOverwrite.armed,
        pending: overwrite.isPending,
        onClick: () => {
          confirmPushForce.reset();
          confirmOverwrite.trigger(() => overwrite.mutate(input));
        },
      }}
      onDisarm={() => {
        confirmPushForce.reset();
        confirmOverwrite.reset();
      }}
    />
  );
}
