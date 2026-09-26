import { useState } from "react";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Button } from "@/components/ui/button";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useStackCleanup } from "@/hooks/pullRequests/useStackCleanup";
import { useDeleteAndNavigate } from "@/hooks/worktrees/useDeleteAndNavigate";
import {
  type StackCleanupFailure,
  useDeleteStackWorktrees,
} from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { notifyError } from "@/lib/toast";
import type { PullRequestStack } from "@shared/pullRequestStack";
import type { Worktree } from "@shared/schemas";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";

const STACK_ERROR_TITLE = "Couldn't delete the stack's worktrees";

// The cleanup after a PR closed: this worktree goes, or, for a stack
// with landed layers, all of their worktrees together, on every device
// holding one (each device's host runs `sm rm --stack`, which removes
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
  const { deviceId } = useHostScope();
  const { data: siblings = [] } = useWorktrees(worktree.projectId);
  const { deleteMutation, runDelete, navigateAway, deleteBlockedReason } =
    useDeleteAndNavigate(worktree, siblings);
  const stackMutation = useDeleteStackWorktrees();
  // What a failed stack removal is offered: force for a refusal (a
  // dirty worktree), a retry or skipping the scripts for a cleanup
  // script that failed, nothing but the message for a peer that will
  // not run commands from here.
  const [stackError, setStackError] = useState<{
    message: string;
    kind: StackCleanupFailure["kind"];
  } | null>(null);
  const { armed, trigger } = useConfirmTwice(CONFIRM_QUICK_MS);
  const { armed: stackArmed, trigger: stackTrigger } =
    useConfirmTwice(CONFIRM_QUICK_MS);
  const cleanup = useStackCleanup(worktree, stack);
  const count = cleanup?.count ?? 0;
  const stackPending = stackMutation.isPending;
  const pending = stackPending || deleteMutation.isPending;

  // A failure shows here while the page is still this worktree's, and
  // as a toast once the removal took the page's own worktree with it.
  // The page's own worktree needn't be among the removed: a closed
  // (unmerged) top over landed layers stays, and so does the page.
  const runStack = (opts: { force?: boolean; skipCleanup?: boolean } = {}) => {
    if (!cleanup) return;
    setStackError(null);
    const own = cleanup.ready.find((device) => device.deviceId === deviceId);
    stackMutation.mutate(
      {
        devices: cleanup.ready,
        worktreeIds: own?.worktrees.map((w) => w.id) ?? [],
        ...opts,
      },
      {
        onSuccess: ({ removed, failures }) => {
          const gone = removed.get(deviceId) ?? [];
          const message = failures
            .map((failure) => `${failure.label}: ${failure.message}`)
            .join("\n");
          if (gone.includes(worktree.id)) {
            if (message) notifyError(STACK_ERROR_TITLE, message);
            navigateAway([...removed.values()].flat());
          } else if (failures.length > 0) {
            const kinds = new Set(failures.map((failure) => failure.kind));
            const kind = kinds.has("cleanup")
              ? "cleanup"
              : kinds.has("error")
                ? "error"
                : "refused";
            setStackError({ message, kind });
          }
        },
      },
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        {count > 1 &&
          (stackError && stackError.kind !== "refused" ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setStackError(null)}
              >
                Cancel
              </Button>
              {stackError.kind === "cleanup" ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => runStack()}
                  >
                    Retry
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() => runStack({ skipCleanup: true })}
                  >
                    Skip cleanup scripts
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={pending}
                  onClick={() => runStack({ force: true })}
                >
                  Delete {count} stack worktrees anyway
                </Button>
              )}
            </>
          ) : (
            <ConfirmDestructiveButton
              armed={stackArmed}
              pending={stackPending}
              disabled={deleteMutation.isPending}
              pendingLabel="Deleting stack…"
              idleLabel={`Delete ${count} stack worktrees`}
              onClick={() => stackTrigger(() => runStack())}
            />
          ))}
        <ConfirmDestructiveButton
          armed={armed}
          pending={deleteMutation.isPending}
          disabled={stackPending}
          pendingLabel="Deleting…"
          idleLabel="Delete worktree"
          onClick={() => trigger(() => runDelete())}
          disabledReason={deleteBlockedReason}
        />
      </div>
      {cleanup && cleanup.blocked.length > 0 && (
        <p className="text-right text-xs text-muted-foreground">
          {cleanup.blocked
            .map((device) =>
              device.block === "offline"
                ? `${device.worktrees.length} more on ${device.label}, which is offline.`
                : `${device.worktrees.length} more on ${device.label}. ${peerReadOnlyNote(device.label)}`,
            )
            .join(" ")}
        </p>
      )}
      {stackError && (
        <ErrorBanner message={stackError.message} title={STACK_ERROR_TITLE} />
      )}
      {deleteMutation.error && (
        <ErrorBanner
          message={deleteMutation.error.message}
          title="Couldn't delete the worktree"
        />
      )}
    </div>
  );
}
