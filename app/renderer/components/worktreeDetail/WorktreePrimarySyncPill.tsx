import { ArrowDown } from "lucide-react";
import {
  useMergePrimaryWorktree,
  useSyncWithPrimaryWorktree,
} from "@/hooks/worktrees/useWorktreeSync";
import { pluralize } from "@/lib/pluralize";
import { notifyError, toast, UNDO_TOAST_MS } from "@/lib/toast";
import { isSyncConflictsError } from "@shared/errors";
import type { Worktree } from "@shared/schemas";
import { SyncActionButton } from "./SyncActionButton";

// Precondition: caller has verified the worktree is eligible
// (non-primary, non-detached, behindPrimary > 0). The label still falls
// back to "primary" defensively in case the primary ref couldn't be
// resolved on the backend.
//
// A sync that conflicts changes nothing, and its toast offers the way
// on: merge anyway and settle the conflicts here (the Git section's
// banner takes it from there).
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
        `git fetch && git rebase ${branchName}, falling back to a merge on conflict`
      }
      disabled={disabledReason !== undefined}
      pending={sync.isPending || merge.isPending}
      onClick={() =>
        sync.mutate(scope, {
          onError: (err) => {
            if (!isSyncConflictsError(err)) {
              notifyError("Couldn't sync from primary", err);
              return;
            }
            toast(`${branchName} conflicts with this branch`, {
              description: "Nothing changed.",
              duration: UNDO_TOAST_MS,
              action: {
                label: "Merge and resolve",
                onClick: () => merge.mutate(scope),
              },
            });
          },
        })
      }
    />
  );
}
