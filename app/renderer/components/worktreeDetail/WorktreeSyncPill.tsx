import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import {
  useMergeUpstreamWorktree,
  useOverwriteWorktree,
  usePushForceWorktree,
  useRunningSyncs,
  useSyncMoveMutations,
  type RunningSync,
} from "@/hooks/worktrees/useWorktreeSync";
import { worktreeSyncView } from "@shigomori/ui/lib/syncState.ts";
import type { Worktree } from "@shigomori/contracts/schemas";
import { assertNever } from "@shigomori/ui/lib/utils.ts";
import { SyncActionButtonView } from "@shigomori/ui/views/worktreeDetail/SyncActionButtonView.tsx";
import {
  HeldSyncView,
  MergeUpstreamView,
  PickSideView,
} from "@shigomori/ui/views/worktreeDetail/WorktreeSyncPillView.tsx";
import type { ReactNode } from "react";

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
  // Held here, not in MergeUpstream: a merge that stops on conflicts
  // dirties the tree, which swaps it for the held hint before its answer
  // lands, and the way to the diff has to outlive that.
  const mergeUpstream = useMergeUpstreamWorktree();
  const running = useRunningSyncs(worktree);
  const { canCommand } = useCommandAccess();

  if (!canCommand) return null;
  if (waiting) {
    // Never the move while it waits.
    if (!held) return null;
    return <HeldSyncView held={held} compact={compact} />;
  }

  // Every move in this pill waits for the others, so a click here can't
  // start one git command beside another.
  const busy = running.length > 0;

  switch (state.kind) {
    case "detached":
    case "synced":
      return null;
    case "publish":
    case "ahead":
    case "behind":
    case "pullAndPush": {
      if (!move) return null;
      const button = (
        <SyncActionButtonView
          tone={move.tone}
          icon={move.arrowsInLabel ? undefined : move.Icon}
          label={compact ? move.compactLabel : move.label}
          tip={move.disabledReason ?? move.tip}
          disabled={move.disabledReason !== undefined || busy}
          pending={running.includes(move.key)}
          onClick={() => mutations[move.key].mutate(input)}
        />
      );
      // A split that merges cleanly can still pick a side instead.
      if (state.kind !== "pullAndPush") return button;
      return (
        <PickSide
          // A new split remounts it, so a confirm armed on the old one
          // can't fire on this one.
          key={`${state.kind}:${state.ahead}/${state.behind}`}
          worktree={worktree}
          lead={button}
          busy={busy}
          running={running}
          ahead={state.ahead}
          behind={state.behind}
          compact={compact}
        />
      );
    }
    case "diverged":
      return (
        <PickSide
          // A new split remounts it, so a confirm armed on the old one
          // can't fire on this one.
          key={`${state.kind}:${state.ahead}/${state.behind}`}
          worktree={worktree}
          lead={
            <MergeUpstream
              input={input}
              mergeUpstream={mergeUpstream}
              behind={state.behind}
              busy={busy}
              pending={running.includes("mergeUpstream")}
            />
          }
          busy={busy}
          running={running}
          ahead={state.ahead}
          behind={state.behind}
          compact={compact}
        />
      );
    default:
      return assertNever(state);
  }
}

// Its own component so only a diverged pill follows the router.
function MergeUpstream({
  input,
  mergeUpstream,
  behind,
  busy,
  pending,
}: {
  input: { projectId: string; worktreeId: string };
  mergeUpstream: ReturnType<typeof useMergeUpstreamWorktree>;
  behind: number;
  busy: boolean;
  pending: boolean;
}) {
  const nav = useWorktreeNav();
  return (
    <MergeUpstreamView
      behind={behind}
      busy={busy}
      pending={pending}
      onClick={() =>
        mergeUpstream.mutate(input, {
          onSuccess: ({ stopped }) => {
            if (stopped) nav.toDiff(input.projectId, input.worktreeId);
          },
        })
      }
    />
  );
}

function PickSide({
  worktree,
  lead,
  busy,
  running,
  ahead,
  behind,
  compact,
}: {
  worktree: Worktree;
  lead: ReactNode;
  busy: boolean;
  running: RunningSync[];
  ahead: number;
  behind: number;
  compact: boolean;
}) {
  const input = { projectId: worktree.projectId, worktreeId: worktree.id };
  const pushForce = usePushForceWorktree();
  const overwrite = useOverwriteWorktree();
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
      busy={busy}
      lead={lead}
      pushForce={{
        armed: confirmPushForce.armed,
        pending: running.includes("pushForce"),
        onClick: () => {
          confirmOverwrite.reset();
          confirmPushForce.trigger(() => pushForce.mutate(input));
        },
      }}
      overwrite={{
        armed: confirmOverwrite.armed,
        pending: running.includes("overwrite"),
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
