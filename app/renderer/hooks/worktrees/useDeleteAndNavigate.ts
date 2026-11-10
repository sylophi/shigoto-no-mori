import { useState } from "react";
import {
  isCommandRefusedError,
  isWorktreeSettingUpError,
} from "@shigomori/contracts/errors";
import { inboxShowing } from "@/components/sidebar/inbox/inboxOrder";
import { notifyError } from "@/lib/toast";
import { useWorktreeSettingUp } from "@/hooks/worktrees/useWorktreeLifecycle";
import { useDeleteWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { CleanupError, Worktree } from "@shigomori/contracts/schemas";

// Why the worktree can't be deleted right now, if it can't. Delete
// waits out the create run (carry-over, setup, port provision), which
// the host refuses to race.
export function useDeleteBlockedReason(worktree: Worktree): string | undefined {
  return useWorktreeSettingUp(worktree)
    ? "Can't delete while the worktree is being set up"
    : undefined;
}

interface DeleteOpts {
  force?: boolean;
  skipCleanup?: boolean;
}

// Where a delete stands once it came back with the worktree still
// there: the host refused it (offer to force it, with what it said), or
// a cleanup script failed (retry or skip it, keeping the force the run
// had, since a dirty worktree is still dirty).
export type DeleteStall =
  | { kind: "refused"; message: string }
  | { kind: "cleanupFailed"; error: CleanupError; force: boolean };

// Delete `worktree` and, on success, route the user to a neighbouring
// worktree (or home if it was the last one), or with the inbox showing
// to its newest work, so the page never lingers on a removed entry.
// Owns where a stalled delete stands (DeleteStall), which the deletion
// affordances hang off of, since both the detail footer and the
// closed-PR box drive the same deletion.
export function useDeleteAndNavigate(
  worktree: Worktree,
  siblings: readonly Worktree[],
) {
  const nav = useWorktreeNav();
  const deleteMutation = useDeleteWorktree();
  const deleteBlockedReason = useDeleteBlockedReason(worktree);
  const [stall, setStall] = useState<DeleteStall | null>(null);

  // `gone` widens the removal past this worktree: a stack removal
  // takes its neighbours too, and the page must not land on one of
  // those.
  const navigateToSibling = (widened?: readonly string[]) => {
    const gone = widened ?? [worktree.id];
    // The inbox has an order of its own (newest work first) and leaves
    // the primary out, so its landing is the fallback's.
    if (inboxShowing()) {
      nav.toFallback(gone, true);
      return;
    }
    // Prefer the sibling above so the user's eye stays in place. The
    // nav helper keeps this on whichever device the page is scoped to
    // (a remote delete lands on the remote sibling, or the root when it
    // was the last one).
    const index = siblings.findIndex((w) => w.id === worktree.id);
    const kept = (w: Worktree) => !gone.includes(w.id);
    const next =
      index >= 0
        ? (siblings.slice(0, index).findLast(kept) ??
          siblings.slice(index + 1).find(kept))
        : undefined;
    if (next) {
      nav.toWorktree(worktree.projectId, next.id, true);
    } else {
      nav.toFallback(gone, true);
    }
  };

  // A refusal stays up while the force it offered runs, so its row
  // can show the run as busy.
  const runDelete = (opts: DeleteOpts = {}) => {
    setStall((now) => (now?.kind === "refused" ? now : null));
    deleteMutation.mutate(
      { projectId: worktree.projectId, worktreeId: worktree.id, ...opts },
      {
        onSuccess: (data) => {
          if (data.ok) {
            setStall(null);
            navigateToSibling();
          } else {
            setStall({
              kind: "cleanupFailed",
              error: data.cleanupError,
              force: opts.force === true,
            });
          }
        },
        onError: (error) => {
          // A peer's command refusal is toasted centrally, and a force
          // delete for it would only be refused again. So would one
          // for a worktree still being set up (a peer's page doesn't
          // see the create phase to disable the button).
          const settingUp = isWorktreeSettingUpError(error);
          if (settingUp) notifyError("Couldn't delete the worktree", error);
          setStall(
            settingUp || isCommandRefusedError(error)
              ? null
              : { kind: "refused", message: error.message },
          );
        },
      },
    );
  };

  const cleanupForce = stall?.kind === "cleanupFailed" && stall.force;

  return {
    deleteMutation,
    stall,
    runDelete,
    deleteBlockedReason,
    // For a removal made another way (a stack cleanup) that took this
    // worktree with it: the same move off the page.
    navigateAway: navigateToSibling,
    retryCleanup: () => runDelete({ force: cleanupForce }),
    skipCleanup: () => runDelete({ force: cleanupForce, skipCleanup: true }),
    // Back to the page's ordinary footer.
    dismiss: () => setStall(null),
  };
}
