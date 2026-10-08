import { ArrowDown, ArrowUp, Ellipsis, GitMerge } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import {
  useMergeUpstreamWorktree,
  useOverwriteWorktree,
  usePushForceWorktree,
  useSyncMoveMutations,
} from "@/hooks/worktrees/useWorktreeSync";
import { worktreeSyncView } from "@/lib/syncState";
import type { Worktree } from "@shared/schemas";
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
  const mergeUpstream = useMergeUpstreamWorktree();

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

// Histories have diverged, and merging them conflicts. The merge `git
// pull` would make, stopped on its conflicts for the Changes tab to
// settle, or one side wins: "overwrite the remote" (force-push) or
// "overwrite local" (reset hard), both behind a two-step confirm.
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
  const busy =
    pushForce.isPending || overwrite.isPending || mergeUpstream.isPending;
  const merge = (
    <SyncActionButton
      tone="sky"
      icon={GitMerge}
      label={`Merge ${behind}`}
      tip="git pull --no-rebase, stopping on the conflicts for you to resolve"
      pending={mergeUpstream.isPending}
      disabled={busy}
      onClick={() =>
        mergeUpstream.mutate(input, {
          onSuccess: ({ worktree: after, stopped }) => {
            if (stopped) nav.toDiff(input.projectId, input.worktreeId);
            else say(after, "Merged the remote's commits");
          },
        })
      }
    />
  );
  // Narrow, the overwrites wait in a menu behind the merge, each still
  // confirmed with a second click.
  if (compact) {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5 self-center text-xs">
        {merge}
        {/* Closing the menu disarms both, so a reopen never finds one
            a click away from firing. */}
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) return;
            confirmPushForce.reset();
            confirmOverwrite.reset();
          }}
        >
          <DropdownMenuTrigger
            aria-label="Overwrite one side"
            disabled={busy}
            className="inline-flex size-6 items-center justify-center rounded-md text-rose-500 hover:bg-rose-500/10 focus-visible:outline-2 focus-visible:outline-rose-500 disabled:opacity-50"
          >
            <Ellipsis aria-hidden className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4}>
            <DropdownMenuItem
              variant="destructive"
              closeOnClick={confirmPushForce.armed}
              onClick={(event) => {
                if (!confirmPushForce.armed) event.preventDefault();
                confirmOverwrite.reset();
                confirmPushForce.trigger(() => pushForce.mutate(input));
              }}
            >
              <ArrowUp />
              {confirmPushForce.armed
                ? "Click again to confirm"
                : `Push ${ahead}, overwriting the remote`}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              closeOnClick={confirmOverwrite.armed}
              onClick={(event) => {
                if (!confirmOverwrite.armed) event.preventDefault();
                confirmPushForce.reset();
                confirmOverwrite.trigger(() => overwrite.mutate(input));
              }}
            >
              <ArrowDown />
              {confirmOverwrite.armed
                ? "Click again to confirm"
                : `Pull ${behind}, overwriting this branch`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 self-center text-xs">
      {merge}
      {/* On the label, not the row: each button has its own tip, and
          two tooltips would stack. */}
      <SimpleTooltip
        tip={`Diverged: ${ahead} local, ${behind} remote. History has split. Pick which side wins.`}
      >
        <span className="px-1.5 text-rose-500">Overwrite:</span>
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
