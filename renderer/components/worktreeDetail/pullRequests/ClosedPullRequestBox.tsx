import { ErrorBanner } from "@/components/ui/error-banner";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useDeleteAndNavigate } from "@/hooks/worktrees/useDeleteAndNavigate";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import type { Worktree } from "@shared/schemas";
import { ConfirmDestructiveButton } from "./ConfirmDestructiveButton";

export function ClosedPullRequestBox({ worktree }: { worktree: Worktree }) {
  const { data: siblings = [] } = useWorktrees(worktree.projectId);
  const { deleteMutation, runDelete } = useDeleteAndNavigate(
    worktree,
    siblings,
  );
  const { armed, trigger } = useConfirmTwice(CONFIRM_QUICK_MS);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ConfirmDestructiveButton
          armed={armed}
          pending={deleteMutation.isPending}
          pendingLabel="Deleting…"
          idleLabel="Delete worktree"
          onClick={() => trigger(() => runDelete())}
        />
      </div>
      {deleteMutation.error && (
        <ErrorBanner>{deleteMutation.error.message}</ErrorBanner>
      )}
    </div>
  );
}
