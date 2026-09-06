import { cn } from "@/lib/utils";
import { BranchLabel } from "@/components/ui/branch-label";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { useProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import type { ScriptActivityKind } from "@/store/scriptRuns";
import type { PullRequest, Worktree } from "@shared/schemas";
import { ActivityIcon } from "./ActivityIcon";
import { PullRequestPill } from "./PullRequestPill";
import { StatusIndicator } from "./StatusIndicator";
import { useWorktreeRowState } from "./useWorktreeRowState";

interface WorktreeRowProps {
  worktree: Worktree;
}

// The row button's shared shell, also worn by RemoteWorktreeRow so a
// peer's worktree reads as a sibling of a local one -- and stays one
// through the next restyle.
// Taller and a size up on a phone: the row is the thumb target there.
export const WORKTREE_ROW_BUTTON =
  "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent/60 phone:py-2 phone:text-[13px]";

// The two-line branch-over-name block both row flavors lead with.
export function WorktreeRowLabel({
  worktree,
  className,
  emphasized = false,
}: {
  worktree: Worktree;
  className?: string;
  emphasized?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col", className)}>
      <span
        className={cn("truncate font-mono", emphasized && "font-medium")}
        title={worktree.detached ? "Detached HEAD (commit hash)" : undefined}
      >
        <BranchLabel branch={worktree.branch} detached={worktree.detached} />
      </span>
      <span className="truncate text-[10px] text-muted-foreground">
        {worktree.name}
      </span>
    </div>
  );
}

export function WorktreeRow({ worktree }: WorktreeRowProps) {
  const { isSelected, open, activity, isDeleting, title } =
    useWorktreeRowState(worktree);
  const { data: prs } = useProjectPullRequests(worktree.projectId);

  return (
    <button
      type="button"
      onClick={open}
      title={title}
      className={cn(
        WORKTREE_ROW_BUTTON,
        isSelected && "bg-accent text-accent-foreground",
        isDeleting && "opacity-50",
      )}
    >
      <WorktreeRowLabel
        worktree={worktree}
        className={worktree.shelved ? "opacity-60" : undefined}
        emphasized={isSelected}
      />
      <RowTrailing
        worktree={worktree}
        activity={activity}
        isDeleting={isDeleting}
        pr={prs?.[worktree.branch]}
      />
    </button>
  );
}

interface RowTrailingProps {
  worktree: Worktree;
  activity: ScriptActivityKind | null;
  isDeleting: boolean;
  // Resolved by the row: the local one off its project's map, a peer's
  // off the map that came with its forest.
  pr: PullRequest | undefined;
}

// The right-edge cluster, shared with RemoteWorktreeRow so a peer's row
// keeps the same marks through the next restyle. Deletion takes the
// whole row (the worktree is going away, so the trash standing alone
// reads as "destroying"); a running script just adds a leading activity
// icon to the normal cluster so status / PR / kind stay visible.
export function RowTrailing({
  worktree,
  activity,
  isDeleting,
  pr,
}: RowTrailingProps) {
  // Deletion spans cleanup scripts + the final git remove; the script
  // activity covers only cleanup, so keep the trash pulsing for the
  // whole mutation regardless of which phase is active.
  if (isDeleting) {
    return <ActivityIcon kind="teardown" />;
  }
  return (
    <>
      {activity && <ActivityIcon kind={activity} />}
      <StatusIndicator worktree={worktree} />
      <PullRequestPill pr={pr} />
      <WorktreeKindIcon worktree={worktree} showTooltip={false} />
    </>
  );
}
