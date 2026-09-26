import { ErrorBanner } from "@/components/ui/error-banner";
import { Button } from "@/components/ui/button";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useStackCleanup } from "@/hooks/pullRequests/useStackCleanup";
import { useDeleteAndNavigate } from "@/hooks/worktrees/useDeleteAndNavigate";
import { useDeleteStackOnDevices } from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import type { PullRequestStack } from "@shared/pullRequestStack";
import type { Worktree } from "@shared/schemas";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";

// The cleanup after a PR closed: this worktree goes, or, for a stack
// with landed layers, all of their worktrees together, on every device
// holding one (each device's host runs `sm land --stack`, which removes
// its merged layers as one). The stack button shows only when it would
// take more than this worktree, since otherwise the two would be the
// same removal. A device that can't be asked (asleep, or not granting
// this one) keeps its worktrees, and the box says so.
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
  const elsewhere = useDeleteStackOnDevices();
  const { armed, trigger } = useConfirmTwice(CONFIRM_QUICK_MS);
  const { armed: stackArmed, trigger: stackTrigger } =
    useConfirmTwice(CONFIRM_QUICK_MS);
  const cleanup = useStackCleanup(worktree, stack);
  const count = cleanup?.count ?? 0;
  const pending =
    deleteMutation.isPending ||
    deleteStackMutation.isPending ||
    elsewhere.isPending;
  const error = deleteMutation.error ?? deleteStackMutation.error;

  // The page's own device through the navigating path, every other
  // device at the same time through its own host.
  const runEverywhere = (force?: boolean) => {
    if (!cleanup) return;
    const others = cleanup.ready.filter((device) => !device.isScoped);
    if (others.length > 0) {
      elsewhere.mutate({
        force,
        devices: others.map((device) => ({
          deviceId: device.deviceId,
          label: device.label,
          projectId: device.projectId,
          targetId: device.targetId,
          // ready: the api is there.
          api: device.api!,
        })),
      });
    }
    if (cleanup.ready.some((device) => device.isScoped)) {
      runDeleteStack({ force });
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        {count > 1 &&
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
                onClick={() => runEverywhere(true)}
              >
                Delete {count} stack worktrees anyway
              </Button>
            </>
          ) : (
            <ConfirmDestructiveButton
              armed={stackArmed}
              pending={deleteStackMutation.isPending || elsewhere.isPending}
              disabled={deleteMutation.isPending}
              pendingLabel="Deleting stack…"
              idleLabel={`Delete ${count} stack worktrees`}
              onClick={() => stackTrigger(() => runEverywhere())}
            />
          ))}
        <ConfirmDestructiveButton
          armed={armed}
          pending={deleteMutation.isPending}
          disabled={deleteStackMutation.isPending || elsewhere.isPending}
          pendingLabel="Deleting…"
          idleLabel="Delete worktree"
          onClick={() => trigger(() => runDelete())}
        />
      </div>
      {cleanup && cleanup.blocked.length > 0 && (
        <p className="text-right text-xs text-muted-foreground">
          {cleanup.blocked
            .map(
              (device) =>
                `${device.worktrees.length} more on ${device.label} (${
                  device.block === "offline" ? "offline" : "read-only from here"
                })`,
            )
            .join(", ")}
        </p>
      )}
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
