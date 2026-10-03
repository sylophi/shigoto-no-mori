import { useSyncWithPrimaryWorktree } from "@/hooks/worktrees/useWorktreeSync";
import type { Worktree } from "@shared/schemas";
import { WorktreePrimarySyncPillView } from "./WorktreePrimarySyncPillView";

// Precondition: caller has verified the worktree is eligible
// (non-primary, non-detached, behindPrimary > 0). The label still falls
// back to "primary" defensively in case the primary ref couldn't be
// resolved on the backend.
export function WorktreePrimarySyncPill({ worktree }: { worktree: Worktree }) {
  const sync = useSyncWithPrimaryWorktree();
  return (
    <WorktreePrimarySyncPillView
      behindPrimary={worktree.behindPrimary}
      primaryRef={worktree.primaryRef}
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
