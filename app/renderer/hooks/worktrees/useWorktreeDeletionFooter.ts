import type { ScriptRunState } from "@shigomori/ui/lib/scriptRun.ts";
import type {
  WorktreeFooterActions,
  WorktreeFooterState,
} from "@shigomori/ui/views/worktreeDetail/WorktreeDetailFooterView.tsx";
import type { Worktree } from "@shigomori/contracts/schemas";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import {
  useScriptRuns,
  useScriptRunState,
} from "@/hooks/scripts/useScriptRuns";
import { useDeleteAndNavigate } from "@/hooks/worktrees/useDeleteAndNavigate";
import { useIsDeletingWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { scriptKey, type ScriptSlot } from "@/store/scriptSlot";

// A cleanup script still in flight.
const live = (state: ScriptRunState) =>
  state.status === "running" || state.status === "starting";

// The worktree page's delete as its footer draws it: the delete itself
// (useDeleteAndNavigate), the cleanup scripts it runs on the way, and
// the banner the page shows while the worktree is going (null while it
// isn't).
export function useWorktreeDeletionFooter(
  worktree: Worktree,
  siblings: readonly Worktree[],
): {
  state: WorktreeFooterState;
  actions: WorktreeFooterActions;
  limboLabel: string | null;
} {
  const { toScript } = useWorktreeNav();
  const scriptRuns = useScriptRuns();
  const {
    deleteMutation,
    needsForce,
    cleanupError,
    runDelete,
    deleteBlockedReason,
    cancelForce,
    retryCleanup,
    skipCleanup,
    clearCleanupError,
  } = useDeleteAndNavigate(worktree, siblings);
  const { armed: confirmDelete, trigger: confirmDeleteTrigger } =
    useConfirmTwice(CONFIRM_QUICK_MS);

  const teardownKey = scriptKey(worktree.projectId, worktree.id, {
    kind: "teardown",
  });
  const releaseKey = scriptKey(worktree.projectId, worktree.id, {
    kind: "portPool",
    phase: "release",
  });
  const teardownState = useScriptRunState(teardownKey);
  const releaseState = useScriptRunState(releaseKey);

  const cleanupRunning = live(teardownState) || live(releaseState);
  // This page's own delete, or a removal the host announced (a mirror
  // stop takes the copy with it, a peer's transplant tears its source
  // down here): the page goes into limbo either way, instead of
  // standing as an ordinary worktree until the row vanishes.
  const busy = useIsDeletingWorktree(worktree.id);
  const cleanupCancelling = teardownState.cancelling || releaseState.cancelling;

  const openCleanupConsole = () => {
    let slot: ScriptSlot;
    if (cleanupError) {
      slot =
        cleanupError.phase === "teardown"
          ? { kind: "teardown" }
          : { kind: "portPool", phase: "release" };
    } else if (releaseState.runId) {
      slot = { kind: "portPool", phase: "release" };
    } else if (teardownState.runId) {
      slot = { kind: "teardown" };
    } else {
      return;
    }
    toScript(worktree.projectId, worktree.id, slot);
  };

  // Order is priority: a cleanup failure and a pending force-delete
  // each override the running/normal views, matching how a delete
  // attempt walks through these phases.
  const state: WorktreeFooterState = cleanupError
    ? { kind: "cleanupError", error: cleanupError }
    : needsForce
      ? {
          kind: "needsForce",
          errorMessage: deleteMutation.error?.message,
          busy,
        }
      : cleanupRunning
        ? { kind: "cleanupRunning", cancelling: cleanupCancelling }
        : {
            kind: "normal",
            confirmDelete,
            busy,
            deleteBlockedReason,
          };

  const actions: WorktreeFooterActions = {
    onCancelCleanupError: clearCleanupError,
    onOpenCleanupConsole: openCleanupConsole,
    onRetryCleanup: retryCleanup,
    onSkipCleanup: skipCleanup,
    onCancelForce: cancelForce,
    onForceDelete: () => runDelete({ force: true }),
    onCancelCleanup: () => {
      if (teardownState.runId) void scriptRuns.cancel(teardownKey);
      if (releaseState.runId) void scriptRuns.cancel(releaseKey);
    },
    onDelete: () => confirmDeleteTrigger(() => runDelete()),
  };

  return {
    state,
    actions,
    limboLabel:
      cleanupRunning || busy ? limboLabel(teardownState, releaseState) : null,
  };
}

// Release runs before teardown, then the actual git remove.
function limboLabel(
  teardownState: ScriptRunState,
  releaseState: ScriptRunState,
): string {
  if (live(releaseState)) {
    return releaseState.cancelling
      ? "Stopping port-pool release..."
      : "Releasing ports...";
  }
  if (live(teardownState)) {
    return teardownState.cancelling
      ? "Stopping teardown..."
      : "Tearing down...";
  }
  return "Removing worktree...";
}
