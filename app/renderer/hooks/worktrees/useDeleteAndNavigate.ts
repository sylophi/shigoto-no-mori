import { useRef, useState } from "react";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import {
  useDeleteStackWorktrees,
  useDeleteWorktree,
} from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { CleanupError, Worktree } from "@shared/schemas";

interface DeleteOpts {
  force?: boolean;
  skipCleanup?: boolean;
}

// Delete `worktree` and, on success, route the user to a neighbouring
// worktree (or home if it was the last one) so the page never lingers on
// a removed entry. Owns the force/cleanup retry state that the deletion
// affordances hang off of, since both the detail footer and the closed-PR
// box drive the same deletion.
export function useDeleteAndNavigate(worktree: Worktree, siblings: Worktree[]) {
  const nav = useWorktreeNav();
  const deleteMutation = useDeleteWorktree();
  const deleteStackMutation = useDeleteStackWorktrees();
  const [needsForce, setNeedsForce] = useState(false);
  const [stackNeedsForce, setStackNeedsForce] = useState(false);
  const [cleanupError, setCleanupError] = useState<CleanupError | null>(null);

  // Tracks the flags from the most recent delete attempt so that the
  // retry/skip affordances on a cleanup failure carry the user's
  // original intent (notably: a force-delete that hit a cleanup error
  // should stay force on retry/skip, since the worktree is still dirty).
  const lastDeleteOptsRef = useRef<{ force?: boolean }>({});

  // `gone` widens the removal past this worktree: a stack removal
  // takes its neighbours too, and the page must not land on one of
  // those.
  const navigateToSibling = (gone: readonly string[] = [worktree.id]) => {
    // Prefer the sibling above so the user's eye stays in place. The
    // nav helper keeps this on whichever device the page is scoped to
    // (a remote delete lands on the remote sibling, or the root when it
    // was the last one).
    const index = siblings.findIndex((w) => w.id === worktree.id);
    const stays = (w: Worktree | undefined) =>
      w && !gone.includes(w.id) ? w : undefined;
    const next =
      index >= 0
        ? (siblings
            .slice(0, index)
            .toReversed()
            .find((w) => stays(w)) ??
          siblings.slice(index + 1).find((w) => stays(w)))
        : undefined;
    if (next) {
      nav.toWorktree(worktree.projectId, next.id, true);
    } else {
      nav.toFallback(true);
    }
  };

  const runDelete = (opts: DeleteOpts = {}) => {
    if (!opts.skipCleanup) {
      lastDeleteOptsRef.current = { force: opts.force };
    }
    setCleanupError(null);
    deleteMutation.mutate(
      { projectId: worktree.projectId, worktreeId: worktree.id, ...opts },
      {
        onSuccess: (data) => {
          if (data.ok) {
            navigateToSibling();
          } else {
            setCleanupError(data.cleanupError);
          }
        },
        onError: (error) => {
          // A peer's command refusal is toasted centrally, and a force
          // delete for it would only be refused again.
          if (!isCommandRefusedError(error)) setNeedsForce(true);
        },
      },
    );
  };

  const cancelForce = () => {
    setNeedsForce(false);
    deleteMutation.reset();
  };

  // The stack's merged layers, this worktree among them. The page
  // moves on if this worktree went, whatever else did; a cleanup
  // failure that kept it shows on the page like a single delete's.
  const runDeleteStack = (opts: { force?: boolean } = {}) => {
    setCleanupError(null);
    deleteStackMutation.mutate(
      { projectId: worktree.projectId, worktreeId: worktree.id, ...opts },
      {
        onSuccess: (data) => {
          setStackNeedsForce(false);
          if (data.removed.includes(worktree.id)) {
            navigateToSibling(data.removed);
          } else if (!data.ok) {
            setCleanupError(data.cleanupError);
          }
        },
        onError: (error) => {
          if (!isCommandRefusedError(error)) setStackNeedsForce(true);
        },
      },
    );
  };

  const cancelStackForce = () => {
    setStackNeedsForce(false);
    deleteStackMutation.reset();
  };

  return {
    deleteMutation,
    deleteStackMutation,
    needsForce,
    stackNeedsForce,
    cleanupError,
    runDelete,
    runDeleteStack,
    cancelForce,
    cancelStackForce,
    retryCleanup: () => runDelete(lastDeleteOptsRef.current),
    skipCleanup: () =>
      runDelete({ ...lastDeleteOptsRef.current, skipCleanup: true }),
    clearCleanupError: () => setCleanupError(null),
  };
}
