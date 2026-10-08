import { Check, GitBranch, TriangleAlert } from "lucide-react";
import { BranchLabel } from "@/components/ui/branch-label";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { SYNC_PILL_SHAPE } from "@/components/worktreeDetail/SyncActionButton";
import { WorktreeSyncPill } from "@/components/worktreeDetail/WorktreeSyncPill";
import { useWorktreeOperation } from "@/hooks/worktrees/useGitHistory";
import { cn } from "@/lib/utils";
import { deriveRemoteSyncState, type Worktree } from "@shared/schemas";

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
  const Icon = detached ? TriangleAlert : GitBranch;
  return (
    <div data-slot="branch-bar" className="flex h-7 items-center gap-2 px-3">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            detached ? "text-amber-500" : "text-muted-foreground",
          )}
        />
        {/* Detached, the hash is short and the tip explains the state.
            On a branch, the tip only finishes a name cut off. */}
        <SimpleTooltip
          whenTruncated={!detached}
          tip={
            detached
              ? "HEAD is on a commit, not a branch: new commits here belong to no branch"
              : branch
          }
        >
          <span className="truncate font-mono select-text">
            <BranchLabel branch={branch} detached={detached} />
          </span>
        </SimpleTooltip>
        {rebasing !== null && (
          <span className="shrink-0 text-muted-foreground">rebasing</span>
        )}
      </span>
      {deriveRemoteSyncState(worktree).kind === "synced" ? (
        <span className={cn(SYNC_PILL_SHAPE, "text-muted-foreground")}>
          <Check aria-hidden className="size-3.5" />
          Up to date
        </span>
      ) : (
        <WorktreeSyncPill worktree={worktree} compact />
      )}
    </div>
  );
}
