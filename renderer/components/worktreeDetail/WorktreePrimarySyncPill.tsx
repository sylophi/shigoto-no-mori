import { ArrowDown } from "lucide-react";
import { useSyncWithPrimaryWorktree } from "@/hooks/worktrees/useWorktreeSync";
import type { Worktree } from "@shared/schemas";
import { commitsLabel, SyncActionButton } from "./SyncActionButton";

// Precondition: caller has verified the worktree is eligible
// (non-primary, non-detached, behindPrimary > 0). The label still falls
// back to "primary" defensively in case the primary ref couldn't be
// resolved on the backend.
export function WorktreePrimarySyncPill({ worktree }: { worktree: Worktree }) {
  const sync = useSyncWithPrimaryWorktree();
  const branchName = worktree.primaryBranch ?? "primary";
  return (
    <SyncActionButton
      tone="sky"
      icon={ArrowDown}
      label={`Sync ${commitsLabel(worktree.behindPrimary)} from ${branchName}`}
      title={`git fetch && git rebase ${branchName}, falling back to a merge on conflict`}
      pending={sync.isPending}
      onClick={() =>
        sync.mutate({
          projectId: worktree.projectId,
          worktreeId: worktree.id,
        })
      }
    />
  );
}
