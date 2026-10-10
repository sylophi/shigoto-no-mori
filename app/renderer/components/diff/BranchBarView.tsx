import type { ReactNode } from "react";
import { Check, GitBranch, TriangleAlert } from "lucide-react";
import { BranchLabel } from "@shigomori/ui/primitives/branch-label.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { SYNC_PILL_SHAPE } from "@shigomori/ui/views/worktreeDetail/SyncActionButtonView.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";

// Where a commit from this page lands, and what the remote is owed:
// the branch on the left, the push (or publish, or pull) on the right
// (BranchBar.tsx reads both off the worktree).
export function BranchBarView({
  branch,
  detached,
  rebasing,
  syncPill,
}: {
  branch: string;
  detached: boolean;
  rebasing: boolean;
  // The remote's move, or null when the branch is up to date.
  syncPill: ReactNode;
}) {
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
        {rebasing && (
          <span className="shrink-0 text-muted-foreground">rebasing</span>
        )}
      </span>
      {syncPill === null ? (
        <span className={cn(SYNC_PILL_SHAPE, "text-muted-foreground")}>
          <Check aria-hidden className="size-3.5" />
          Up to date
        </span>
      ) : (
        syncPill
      )}
    </div>
  );
}
