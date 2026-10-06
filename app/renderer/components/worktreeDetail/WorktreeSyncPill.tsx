import { ArrowDown, ArrowUp, CloudUpload } from "lucide-react";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import {
  useOverwriteWorktree,
  usePublishWorktree,
  usePullAndPushWorktree,
  usePullWorktree,
  usePushForceWorktree,
  usePushWorktree,
  useWorktreeSyncing,
} from "@/hooks/worktrees/useWorktreeSync";
import { pluralize } from "@/lib/pluralize";
import { deriveRemoteSyncState, type Worktree } from "@shared/schemas";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { SyncActionButton } from "./SyncActionButton";

interface WorktreeSyncPillProps {
  worktree: Worktree;
  // The tree has uncommitted changes. Pushing and publishing only send
  // commits, so they stay offered. Every way of taking the remote's
  // commits rewrites the tree (a rebase refuses to start on a dirty
  // one), so those give way to a hint that says what is waiting.
  dirty?: boolean;
  // Short labels ("Push 2") for a narrow strip, the full sentence in
  // the tooltip instead.
  compact?: boolean;
}

// Renders the remote-sync action(s) for a worktree. Returns null in the
// states where there's nothing to show (synced, detached) so the header
// stays quiet.
export function WorktreeSyncPill({
  worktree,
  dirty = false,
  compact = false,
}: WorktreeSyncPillProps) {
  const state = deriveRemoteSyncState(worktree);
  const input = { projectId: worktree.projectId, worktreeId: worktree.id };

  const push = usePushWorktree();
  const pull = usePullWorktree();
  const pushForce = usePushForceWorktree();
  const overwrite = useOverwriteWorktree();
  const publish = usePublishWorktree();
  const pullAndPush = usePullAndPushWorktree();
  // Another control's sync for this worktree holds these still too.
  const syncing = useWorktreeSyncing(worktree.id);
  // Both diverged actions throw away one side's commits, which is more
  // destructive than "Delete worktree" (that one keeps the branch). Same
  // two-step confirm, and arming one disarms the other so a stray second
  // click can't land on the button the user didn't mean.
  const confirmPushForce = useConfirmTwice(CONFIRM_QUICK_MS);
  const confirmOverwrite = useConfirmTwice(CONFIRM_QUICK_MS);

  if (state.kind === "detached" || state.kind === "synced") return null;

  if (
    dirty &&
    (state.kind === "behind" ||
      state.kind === "pullAndPush" ||
      state.kind === "diverged")
  ) {
    return (
      <SimpleTooltip
        tip={`${state.kind === "behind" ? `${pluralize(state.behind, "commit")} to pull` : `Diverged from the remote: ${state.ahead} local, ${state.behind} remote`}. Commit or discard your changes to pull.`}
      >
        <span className="tabular inline-flex shrink-0 items-center gap-1 self-center rounded-md px-1.5 py-1 text-xs text-muted-foreground">
          {state.kind === "behind"
            ? compact
              ? `${state.behind} to pull`
              : `${pluralize(state.behind, "commit")} to pull`
            : `Diverged ↑${state.ahead}↓${state.behind}`}
          <ArrowDown aria-hidden className="size-3.5" />
        </span>
      </SimpleTooltip>
    );
  }

  if (state.kind === "publish") {
    return (
      <SyncActionButton
        tone="violet"
        icon={CloudUpload}
        label={compact ? "Publish" : "Publish branch"}
        tip={
          state.canPublish
            ? compact
              ? "Publish this branch to the remote"
              : undefined
            : "No git remote is configured for this project"
        }
        disabled={!state.canPublish || syncing}
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
        label={
          compact
            ? `Push ${state.ahead}`
            : `Push ${pluralize(state.ahead, "commit")}`
        }
        tip={
          compact
            ? `Push ${pluralize(state.ahead, "commit")} to the remote`
            : undefined
        }
        pending={push.isPending}
        disabled={syncing}
        onClick={() => push.mutate(input)}
      />
    );
  }

  if (state.kind === "behind") {
    return (
      <SyncActionButton
        tone="sky"
        icon={ArrowDown}
        label={
          compact
            ? `Pull ${state.behind}`
            : `Pull ${pluralize(state.behind, "commit")}`
        }
        tip={
          compact
            ? `Pull ${pluralize(state.behind, "commit")} from the remote`
            : undefined
        }
        pending={pull.isPending}
        disabled={syncing}
        onClick={() => pull.mutate(input)}
      />
    );
  }

  if (state.kind === "pullAndPush") {
    return (
      <SyncActionButton
        tone="indigo"
        label={`${compact ? "Sync" : "Pull and push"} ↑${state.ahead}↓${state.behind}`}
        tip="git pull --rebase, falling back to a merge on conflict, then git push"
        pending={pullAndPush.isPending}
        disabled={syncing}
        onClick={() => pullAndPush.mutate(input)}
      />
    );
  }

  // Histories have truly diverged. The only moves left are "overwrite the
  // remote" (force-push) or "overwrite local" (reset hard), both behind a
  // two-step confirm.
  // pull --rebase would almost certainly fail mid-flight here, so we don't
  // offer it. The user picks which side wins.
  const busy = pushForce.isPending || overwrite.isPending || syncing;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 self-center text-xs">
      {/* On the label, not the row: each button has its own tip, and
          two tooltips would stack. */}
      <SimpleTooltip
        tip={`Diverged: ${state.ahead} local, ${state.behind} remote. History has split. Pick which side wins.`}
      >
        <span className="px-1.5 text-rose-500">
          {compact ? "Overwrite" : "Overwrite:"}
        </span>
      </SimpleTooltip>
      <SyncActionButton
        tone="rose"
        icon={ArrowUp}
        label={confirmPushForce.armed ? "Confirm?" : `Push ${state.ahead}`}
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
        label={confirmOverwrite.armed ? "Confirm?" : `Pull ${state.behind}`}
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
