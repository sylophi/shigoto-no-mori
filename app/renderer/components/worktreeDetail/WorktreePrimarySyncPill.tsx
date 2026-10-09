import { ArrowDown } from "lucide-react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import {
  useMergePrimaryWorktree,
  useSyncWithPrimaryWorktree,
} from "@/hooks/worktrees/useWorktreeSync";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { pluralize } from "@/lib/pluralize";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import { isSyncConflictsError } from "@shigomori/contracts/errors";
import type { Worktree } from "@shigomori/contracts/schemas";
import { SyncActionButton } from "./SyncActionButton";

// Precondition: caller has verified the worktree is eligible
// (non-primary, non-detached, behindPrimary > 0). The label still falls
// back to "primary" defensively in case the primary ref couldn't be
// resolved on the backend.
//
// A sync that conflicts changes nothing, and its toast offers the way
// on: merge anyway and settle the conflicts here (the Git section's
// banner takes it from there). None on a peer that takes no commands
// from here.
export function WorktreePrimarySyncPill({
  worktree,
  label,
  disabledReason,
}: {
  worktree: Worktree;
  // A shorter label where the counts are already on screen.
  label?: string;
  // Why it can't run now (uncommitted changes), shown as its tooltip.
  disabledReason?: string;
}) {
  const sync = useSyncWithPrimaryWorktree();
  const merge = useMergePrimaryWorktree();
  const nav = useWorktreeNav();
  const { canCommand } = useCommandAccess();
  if (!canCommand) return null;
  const branchName = worktree.primaryRef ?? "primary";
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  return (
    <SyncActionButton
      tone="sky"
      icon={ArrowDown}
      label={
        label ??
        `Sync ${pluralize(worktree.behindPrimary, "commit")} from ${branchName}`
      }
      tip={
        disabledReason ??
        `git fetch && git rebase ${branchName}, or a merge once commits here are pushed or a rebase conflicts`
      }
      disabled={disabledReason !== undefined}
      pending={sync.isPending || merge.isPending}
      onClick={() =>
        sync.mutate(scope, {
          onError: (err) => {
            if (!isSyncConflictsError(err)) return;
            toast(`${branchName} conflicts with this branch`, {
              description: "Nothing changed.",
              duration: UNDO_TOAST_MS,
              action: {
                label: "Merge and resolve",
                onClick: () =>
                  merge.mutate(scope, {
                    onSuccess: ({ stopped }) => {
                      if (stopped)
                        nav.toDiff(scope.projectId, scope.worktreeId);
                    },
                  }),
              },
            });
          },
        })
      }
    />
  );
}
