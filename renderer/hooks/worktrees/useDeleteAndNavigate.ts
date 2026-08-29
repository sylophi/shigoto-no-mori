import { useRef, useState } from "react";
import { useDeleteWorktree } from "@/hooks/worktrees/useWorktreeMutations";
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
  const [needsForce, setNeedsForce] = useState(false);
  const [cleanupError, setCleanupError] = useState<CleanupError | null>(null);

  // Tracks the flags from the most recent delete attempt so that the
  // retry/skip affordances on a cleanup failure carry the user's
  // original intent (notably: a force-delete that hit a cleanup error
  // should stay force on retry/skip, since the worktree is still dirty).
  const lastDeleteOptsRef = useRef<{ force?: boolean }>({});

  const navigateToSibling = () => {
    // Prefer the sibling above so the user's eye stays in place. The
    // nav helper keeps this on whichever device tree the page lives in
    // (a remote delete lands on the remote sibling, or the device's
    // forest page when it was the last one).
    const index = siblings.findIndex((w) => w.id === worktree.id);
    const next =
      index >= 0 ? (siblings[index - 1] ?? siblings[index + 1]) : undefined;
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
        onError: () => setNeedsForce(true),
      },
    );
  };

  const cancelForce = () => {
    setNeedsForce(false);
    deleteMutation.reset();
  };

  return {
    deleteMutation,
    needsForce,
    cleanupError,
    runDelete,
    cancelForce,
    retryCleanup: () => runDelete(lastDeleteOptsRef.current),
    skipCleanup: () =>
      runDelete({ ...lastDeleteOptsRef.current, skipCleanup: true }),
    clearCleanupError: () => setCleanupError(null),
  };
}
