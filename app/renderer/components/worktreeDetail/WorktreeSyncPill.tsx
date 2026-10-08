import { ArrowDown, ArrowUp } from "lucide-react";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import {
  useOverwriteWorktree,
  usePushForceWorktree,
  useSyncMoveMutations,
} from "@/hooks/worktrees/useWorktreeSync";
import { worktreeSyncView } from "@/lib/syncState";
import type { Worktree } from "@shigomori/contracts/schemas";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { assertNever, cn } from "@/lib/utils";
import { SYNC_PILL_SHAPE, SyncActionButton } from "./SyncActionButton";

interface WorktreeSyncPillProps {
  worktree: Worktree;
  // Short labels ("Push 2") for a narrow strip, the full sentence in
  // the tooltip instead.
  compact?: boolean;
}

// The remote-sync action(s) for a worktree, as lib/syncState says.
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

  if (waiting) {
    // Never the move while it waits.
    if (!held) return null;
    return (
      <SimpleTooltip tip={held.tip}>
        <span className={cn(SYNC_PILL_SHAPE, "text-muted-foreground")}>
          {compact ? (held.compactLabel ?? held.label) : held.label}
          {held.Icon && <held.Icon aria-hidden className="size-3.5" />}
        </span>
      </SimpleTooltip>
    );
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
        <SyncActionButton
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
          input={input}
          pushForce={pushForce}
          overwrite={overwrite}
          ahead={state.ahead}
          behind={state.behind}
          compact={compact}
        />
      );
    default:
      return assertNever(state);
  }
}

// Histories have truly diverged. The only moves left are "overwrite the
// remote" (force-push) or "overwrite local" (reset hard), both behind a
// two-step confirm. The user picks which side wins.
function PickSide({
  input,
  pushForce,
  overwrite,
  ahead,
  behind,
  compact,
}: {
  input: { projectId: string; worktreeId: string };
  pushForce: ReturnType<typeof usePushForceWorktree>;
  overwrite: ReturnType<typeof useOverwriteWorktree>;
  ahead: number;
  behind: number;
  compact: boolean;
}) {
  // Both actions throw away one side's commits, which is more
  // destructive than "Delete worktree" (that one keeps the branch). Same
  // two-step confirm, and arming one disarms the other so a stray second
  // click can't land on the button the user didn't mean.
  const confirmPushForce = useConfirmTwice(CONFIRM_QUICK_MS);
  const confirmOverwrite = useConfirmTwice(CONFIRM_QUICK_MS);
  const busy = pushForce.isPending || overwrite.isPending;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 self-center text-xs">
      {/* On the label, not the row: each button has its own tip, and
          two tooltips would stack. */}
      <SimpleTooltip
        tip={`Diverged: ${ahead} local, ${behind} remote. History has split. Pick which side wins.`}
      >
        <span className="px-1.5 text-rose-500">
          {compact ? "Overwrite" : "Overwrite:"}
        </span>
      </SimpleTooltip>
      <SyncActionButton
        tone="rose"
        icon={ArrowUp}
        label={confirmPushForce.armed ? "Confirm?" : `Push ${ahead}`}
        tip={
          confirmPushForce.armed
            ? "Click again to confirm"
            : "git push --force-with-lease (overwrites the remote)"
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
        label={confirmOverwrite.armed ? "Confirm?" : `Pull ${behind}`}
        tip={
          confirmOverwrite.armed
            ? "Click again to confirm"
            : "git fetch && git reset --hard @{u} (overwrites local)"
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
