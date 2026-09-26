import { ErrorBanner } from "@/components/ui/error-banner";
import { Button } from "@/components/ui/button";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useDeleteAndNavigate } from "@/hooks/worktrees/useDeleteAndNavigate";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import {
  type PullRequestStack,
  stackCleanupFor,
} from "@shared/pullRequestStack";
import type { Worktree } from "@shared/schemas";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";

// The cleanup after a PR closed: this worktree goes, or, for a stack
// with landed layers, all of their worktrees together (the host runs
// `sm land --stack`, which removes the merged layers as one). The
// stack button shows only when it would take more than this worktree,
// since otherwise the two would be the same removal.
export function ClosedPullRequestBox({
  worktree,
  stack,
}: {
  worktree: Worktree;
  stack: PullRequestStack | null;
}) {
  const { data: siblings = [] } = useWorktrees(worktree.projectId);
  const {
    deleteMutation,
    deleteStackMutation,
    stackNeedsForce,
    runDelete,
    runDeleteStack,
    cancelStackForce,
  } = useDeleteAndNavigate(worktree, siblings);
  const { armed, trigger } = useConfirmTwice(CONFIRM_QUICK_MS);
  const { armed: stackArmed, trigger: stackTrigger } =
    useConfirmTwice(CONFIRM_QUICK_MS);
  const cleanup = stack ? stackCleanupFor(stack, siblings) : null;
  const stackCount = cleanup?.worktrees.length ?? 0;
  const pending = deleteMutation.isPending || deleteStackMutation.isPending;
  const error = deleteMutation.error ?? deleteStackMutation.error;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        {stackCount > 1 &&
          (stackNeedsForce ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={cancelStackForce}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => runDeleteStack({ force: true })}
              >
                Delete {stackCount} stack worktrees anyway
              </Button>
            </>
          ) : (
            <ConfirmDestructiveButton
              armed={stackArmed}
              pending={deleteStackMutation.isPending}
              disabled={deleteMutation.isPending}
              pendingLabel="Deleting stack…"
              idleLabel={`Delete ${stackCount} stack worktrees`}
              onClick={() => stackTrigger(() => runDeleteStack())}
            />
          ))}
        <ConfirmDestructiveButton
          armed={armed}
          pending={deleteMutation.isPending}
          disabled={deleteStackMutation.isPending}
          pendingLabel="Deleting…"
          idleLabel="Delete worktree"
          onClick={() => trigger(() => runDelete())}
        />
      </div>
      {error && (
        <ErrorBanner
          message={error.message}
          title={
            deleteStackMutation.error
              ? "Couldn't delete the stack's worktrees"
              : "Couldn't delete the worktree"
          }
        />
      )}
    </div>
  );
}
