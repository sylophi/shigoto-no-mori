import { WorktreeSyncPill } from "@/components/worktreeDetail/WorktreeSyncPill";
import { useWorktreeOperation } from "@/hooks/worktrees/useGitHistory";
import { BranchBarView } from "./BranchBarView";
import {
  deriveRemoteSyncState,
  type Worktree,
} from "@shigomori/contracts/schemas";

// Where a commit from this page lands, and what the remote is owed:
// the branch on the left, the push (or publish, or pull) on the right.
// It stays up on a clean tree too, since that is exactly when a fresh
// commit is waiting to go out, so the page never has to be left to
// push what it just made.
export function BranchBar({ worktree }: { worktree: Worktree }) {
  // Mid-rebase, git holds HEAD detached, but the branch is still the
  // one being replayed, and the banner above says the rest.
  const { data: operation } = useWorktreeOperation(worktree);
  const rebasing = worktree.detached ? (operation?.rebasing ?? null) : null;
  const detached = worktree.detached && rebasing === null;
  const branch = rebasing ?? worktree.branch;
  return (
    <BranchBarView
      branch={branch}
      detached={detached}
      rebasing={rebasing !== null}
      syncPill={
        deriveRemoteSyncState(worktree).kind === "synced" ? null : (
          <WorktreeSyncPill worktree={worktree} compact />
        )
      }
    />
  );
}
