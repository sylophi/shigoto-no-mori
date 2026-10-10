import { useState } from "react";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useStackCleanup } from "@/hooks/pullRequests/useStackCleanup";
import { useDeleteAndNavigate } from "@/hooks/worktrees/useDeleteAndNavigate";
import { useDeleteStackWorktrees } from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { peerReadOnlyNote } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { notifyError } from "@/lib/toast";
import type { PullRequestStack } from "@shared/pullRequestStack";
import type { Worktree } from "@shigomori/contracts/schemas";
import {
  ClosedPullRequestBoxView,
  type DeleteReach,
  STACK_ERROR_TITLE,
  type StackError,
  type StackRunOptions,
} from "./ClosedPullRequestBoxView";

// The cleanup after a PR closed: this worktree goes, or, for a stack
// with landed layers, all of their worktrees together, on every device
// holding one (each device's host runs `sm rm --stack`, which removes
// its merged layers as one). One button, and a menu beside it to reach
// the whole stack only when that would take more than this worktree,
// since otherwise the two would be the same removal. A failed stack
// removal offers its way on beside deleting this worktree alone. A
// device that can't be asked (asleep, or not granting this one) keeps
// its worktrees, and the box says so.
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
  const [stackError, setStackError] = useState<StackError | null>(null);
  const {
    armed,
    trigger: confirm,
    reset: resetConfirm,
  } = useConfirmTwice(CONFIRM_QUICK_MS);
  const [chosenReach, setReach] = useState<DeleteReach>("one");
  const cleanup = useStackCleanup(worktree, stack);
  const count = cleanup?.count ?? 0;
  // The stack only while there is one to take: a stack that shrank to
  // this worktree has no menu left to choose it back from.
  const reach = count > 1 ? chosenReach : "one";

  // A failure shows here while the page is still this worktree's, and
  // as a toast once the removal took the page's own worktree with it.
  // The page's own worktree needn't be among the removed: a closed
  // (unmerged) top over landed layers stays, and so does the page.
  const runStack = (opts: StackRunOptions = {}) => {
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
    <ClosedPullRequestBoxView
      count={count}
      reach={reach}
      armed={armed}
      deletePending={deleteMutation.isPending}
      stackPending={stackMutation.isPending}
      deleteBlockedReason={deleteBlockedReason}
      blockedNote={
        cleanup && cleanup.blocked.length > 0
          ? cleanup.blocked
              .map((device) =>
                device.block === "offline"
                  ? `${device.worktrees.length} more on ${device.label}, which is offline.`
                  : `${device.worktrees.length} more on ${device.label}. ${peerReadOnlyNote(device.label)}`,
              )
              .join(" ")
          : null
      }
      stackError={stackError}
      deleteError={deleteMutation.error?.message ?? null}
      onDelete={() => confirm(() => runDelete())}
      onDeleteStack={() => confirm(() => runStack())}
      onRunStack={runStack}
      onPickReach={(value) => {
        resetConfirm();
        setReach(value);
      }}
      onDismissStackError={() => setStackError(null)}
    />
  );
}
