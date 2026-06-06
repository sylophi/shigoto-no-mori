import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useBranches } from "@/hooks/git/useBranches";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useSwitchToPrimaryAndDeleteBranch } from "@/hooks/worktrees/useWorktreeBranchOps";
import { cn } from "@/lib/utils";
import { isRealBranch, type Worktree } from "@shared/schemas";

// Primary-worktree analog of ClosedPullRequestBox's "Delete worktree":
// the repo root can't be removed, so once its branch is merged we offer
// to switch it back to the primary branch and delete the merged branch
// — the same cleanup a regular worktree gets, adapted to the root.
//
// Both halves run as one main-side operation (worktrees.switchToPrimaryAndDeleteBranch):
// the switch unmounts this box, and a renderer-chained delete would be lost
// to that unmount (React Query drops mutate() callbacks once their component
// is gone). Failures surface via a global toast for the same reason.
export function MergedPrimaryBranchBox({ worktree }: { worktree: Worktree }) {
  const { data: defaultBranch } = useDefaultBranch(worktree.projectId);
  const { data: branches } = useBranches(worktree.projectId);
  const cleanup = useSwitchToPrimaryAndDeleteBranch();
  const { armed, trigger } = useConfirmTwice(CONFIRM_QUICK_MS);

  // Wait for the primary ref to resolve, and never offer this on a
  // detached HEAD (no branch to delete).
  if (!defaultBranch || !isRealBranch(worktree.branch)) return null;

  // The default branch can resolve to a remote-tracking ref (e.g.
  // "origin/main"); strip the remote prefix for the local branch name we
  // show in the label and compare against. The actual switch (land on the
  // local tracking branch + fast-forward onto the remote tip) and the delete
  // of the merged branch are done server-side in one atomic operation.
  const remoteSet = new Set(branches?.remote ?? []);
  const target = remoteSet.has(defaultBranch)
    ? defaultBranch.replace(/^[^/]+\//, "")
    : defaultBranch;
  // Already on the primary branch — nothing to switch to or delete.
  if (target === worktree.branch) return null;

  const run = () => {
    cleanup.mutate({
      projectId: worktree.projectId,
      worktreeId: worktree.id,
    });
  };

  return (
    <div className="flex justify-end">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={cleanup.isPending}
        onClick={() => trigger(run)}
        className={cn(
          "text-destructive hover:bg-destructive/10 hover:text-destructive",
          armed && "bg-destructive/10",
        )}
      >
        {cleanup.isPending ? (
          <>
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            {`Switching to ${target}…`}
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
  );
}
