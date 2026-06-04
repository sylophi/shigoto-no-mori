import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useBranches, useDeleteBranch } from "@/hooks/git/useBranches";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useCheckoutBranch } from "@/hooks/worktrees/useWorktreeBranchOps";
import { cn } from "@/lib/utils";
import { isRealBranch, type Worktree } from "@shared/schemas";

// Primary-worktree analog of ClosedPullRequestBox's "Delete worktree":
// the repo root can't be removed, so once its branch is merged we offer
// to switch it back to the primary branch and delete the merged branch
// — the same cleanup a regular worktree gets, adapted to the root.
export function MergedPrimaryBranchBox({ worktree }: { worktree: Worktree }) {
  const { data: defaultBranch } = useDefaultBranch(worktree.projectId);
  const { data: branches } = useBranches(worktree.projectId);
  const checkout = useCheckoutBranch();
  const del = useDeleteBranch();
  const { armed, trigger } = useConfirmTwice(CONFIRM_QUICK_MS);

  // Wait for the primary ref to resolve, and never offer this on a
  // detached HEAD (no branch to delete).
  if (!defaultBranch || !isRealBranch(worktree.branch)) return null;

  // The default branch can resolve to a remote-tracking ref (e.g.
  // "origin/main"); strip the remote prefix so `git checkout` DWIMs into
  // the local tracking branch instead of detached HEAD — mirroring
  // BranchSwitcher's remote-orphan handling.
  const remoteSet = new Set(branches?.remote ?? []);
  const target = remoteSet.has(defaultBranch)
    ? defaultBranch.replace(/^[^/]+\//, "")
    : defaultBranch;
  // Already on the primary branch — nothing to switch to or delete.
  if (target === worktree.branch) return null;

  const busy = checkout.isPending || del.isPending;
  // Capture before checkout flips worktree.branch to the primary branch.
  const mergedBranch = worktree.branch;

  const run = () => {
    checkout.mutate(
      {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        branch: target,
      },
      {
        // Only delete once the root has switched off the merged branch —
        // git refuses to delete a branch checked out anywhere.
        onSuccess: () => {
          del.mutate({ projectId: worktree.projectId, name: mergedBranch });
        },
      },
    );
  };

  // Checkout failures (e.g. a dirty root) keep this box mounted, so its
  // error shows here. A delete failure may unmount the box once the
  // branch has switched, but useDeleteBranch toasts on error, so it's
  // still surfaced.
  const error = checkout.error ?? del.error;

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => trigger(run)}
          className={cn(
            "text-destructive hover:bg-destructive/10 hover:text-destructive",
            armed && "bg-destructive/10",
          )}
        >
          {busy ? (
            <>
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
              {checkout.isPending ? `Switching to ${target}…` : "Deleting…"}
            </>
          ) : armed ? (
            "Click again to confirm"
          ) : (
            <>
              <Trash2 aria-hidden className="size-3.5" />
              {`Delete branch and switch to ${target}`}
            </>
          )}
        </Button>
      </div>
      {error && <ErrorBanner>{error.message}</ErrorBanner>}
    </div>
  );
}
