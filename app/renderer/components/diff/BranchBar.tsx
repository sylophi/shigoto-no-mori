import { Check, GitBranch, TriangleAlert } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { WorktreeSyncPill } from "@/components/worktreeDetail/WorktreeSyncPill";
import { deriveRemoteSyncState, type Worktree } from "@shared/schemas";

// Where a commit from this page lands, and what the remote is owed:
// the branch on the left, the push (or publish, or pull) on the right.
// It stays up on a clean tree too, since that is exactly when a fresh
// commit is waiting to go out, so the page never has to be left to
// push what it just made.
export function BranchBar({
  worktree,
  dirty,
}: {
  worktree: Worktree;
  dirty: boolean;
}) {
  const state = deriveRemoteSyncState(worktree);
  return (
    <div
      data-slot="branch-bar"
      className="flex min-h-9 items-center gap-2 px-3 py-1"
    >
      {worktree.detached ? (
        <SimpleTooltip tip="HEAD is on a commit, not a branch: new commits here belong to no branch">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
            <TriangleAlert
              aria-hidden
              className="size-3.5 shrink-0 text-amber-500"
            />
            <span className="font-mono">{worktree.branch}</span>
            <span className="truncate text-amber-500">detached</span>
          </span>
        </SimpleTooltip>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
          <GitBranch
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <SimpleTooltip whenTruncated tip={worktree.branch}>
            <span className="truncate font-mono select-text">
              {worktree.branch}
            </span>
          </SimpleTooltip>
        </span>
      )}
      {state.kind === "synced" ? (
        <span className="inline-flex shrink-0 items-center gap-1 px-1.5 text-xs text-muted-foreground">
          <Check aria-hidden className="size-3.5" />
          Up to date
        </span>
      ) : (
        <WorktreeSyncPill worktree={worktree} dirty={dirty} compact />
      )}
    </div>
  );
}
