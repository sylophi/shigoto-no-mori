import { RefreshCw } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { BranchLabel } from "@/components/ui/branch-label";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { DeviceBadge, type SidebarDeviceBadge } from "./DeviceBadge";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
import { useProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { pullRequestStackPosition, trunkOf } from "@shared/pullRequestStack";
import type { ScriptActivityKind } from "@/store/scriptRuns";
import type { PullRequest, Worktree } from "@shared/schemas";
import { ActivityIcon } from "./ActivityIcon";
import { PullRequestPill } from "./PullRequestPill";
import { StatusIndicator } from "./StatusIndicator";
import type { StackChild } from "./sidebarRow";
import { useWorktreeRowState } from "./useWorktreeRowState";

interface WorktreeRowProps {
  worktree: Worktree;
  // The peer this worktree is mirrored with, when it is: the row then
  // stands for both copies and wears the peer's badge.
  mirror?: SidebarDeviceBadge;
  stackChild?: StackChild;
}

// The row button's shared shell, also worn by RemoteWorktreeRow so a
// peer's worktree reads as a sibling of a local one -- and stays one
// through the next restyle.
export const WORKTREE_ROW_BUTTON =
  "group relative flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent/60";

// The two-line branch-over-name block both row flavors lead with, faded
// back for a shelved worktree.
export function WorktreeRowLabel({
  worktree,
  emphasized = false,
}: {
  worktree: Worktree;
  emphasized?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col",
        worktree.shelved && "opacity-60",
      )}
    >
      <span
        className={cn("truncate font-mono", emphasized && "font-medium")}
        title={worktree.detached ? "Detached HEAD (commit hash)" : undefined}
      >
        <BranchLabel branch={worktree.branch} detached={worktree.detached} />
      </span>
      <span className="truncate text-3xs text-muted-foreground">
        {worktree.name}
      </span>
    </div>
  );
}

// A stack's rows draw as a file tree: the lowest layer is the parent
// and every layer built on it a child one step in, hung on the same
// connectors a file tree uses (a tee, the last child a corner). The
// connector is filled strips rather than a bordered box: doubutsu
// clears every border color, and a connector that vanishes with the
// theme would leave the indent unexplained.
const STACK_CHILD_INSET_PX = 12;

export function stackIndentStyle(
  child: StackChild | undefined,
): CSSProperties | undefined {
  if (!child) return undefined;
  return {
    marginLeft: STACK_CHILD_INSET_PX,
    width: `calc(100% - ${STACK_CHILD_INSET_PX}px)`,
  };
}

export function StackConnector({ child }: { child: StackChild | undefined }) {
  if (!child) return null;
  return (
    <span aria-hidden className="absolute inset-y-0 -left-2 w-1.5">
      <span
        className={cn(
          "absolute top-0 left-0 w-px bg-muted-foreground/40",
          child === "last" ? "h-1/2" : "bottom-0",
        )}
      />
      <span className="absolute inset-x-0 top-1/2 h-px bg-muted-foreground/40" />
    </span>
  );
}

export function WorktreeRow({
  worktree,
  mirror,
  stackChild,
}: WorktreeRowProps) {
  const { isSelected, open, activity, isDeleting, title } =
    useWorktreeRowState(worktree);
  const { data: prs } = useProjectPullRequests(worktree.projectId);
  // The row's own project listing, already cached: the trunk the stack
  // walk stops at is its primary checkout's branch.
  const { data: siblings } = useWorktrees(worktree.projectId);

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
      style={stackIndentStyle(stackChild)}
    >
      <StackConnector child={stackChild} />
      <WorktreeRowLabel worktree={worktree} emphasized={isSelected} />
      <RowTrailing
        worktree={worktree}
        activity={activity}
        isDeleting={isDeleting}
        pr={prs?.[worktree.branch]}
        stack={pullRequestStackPosition(
          prs,
          worktree.branch,
          trunkOf(siblings),
        )}
      />
      {mirror && <MirrorBadge mirror={mirror} />}
    </button>
  );
}

// The mark a local row wears for the peer it is mirrored with: the
// mirror glyph and the peer's badge. Shared with the inbox row.
export function MirrorBadge({ mirror }: { mirror: SidebarDeviceBadge }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <SimpleTooltip tip={`Mirrored with ${mirror.label}`}>
        <RefreshCw
          aria-label={`Mirrored with ${mirror.label}`}
          className="size-3 text-emerald-600 dark:text-emerald-400"
        />
      </SimpleTooltip>
      <DeviceBadge badge={mirror} />
    </span>
  );
}

interface RowTrailingProps {
  worktree: Worktree;
  activity: ScriptActivityKind | null;
  isDeleting: boolean;
  // Resolved by the row: the local one off its project's map, a peer's
  // off the map that came with its forest.
  pr: PullRequest | undefined;
  // The PR's place in its stack, off the same map.
  stack?: { index: number; size: number } | null;
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
  stack,
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
      <PullRequestPill pr={pr} stack={stack} />
      <WorktreeKindIcon worktree={worktree} showTooltip={false} />
    </>
  );
}
