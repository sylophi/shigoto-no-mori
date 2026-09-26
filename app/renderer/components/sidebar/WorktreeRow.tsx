import { RefreshCw } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { BranchLabel } from "@/components/ui/branch-label";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { DeviceBadge, type SidebarDeviceBadge } from "./DeviceBadge";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
import { BirthdayBadge } from "@/components/villagers/BirthdayBadge";
import type { ScriptActivityKind } from "@/store/scriptRuns";
import type { PullRequest, Worktree } from "@shared/schemas";
import { ActivityIcon } from "./ActivityIcon";
import { PullRequestPill } from "./PullRequestPill";
import { StatusIndicator } from "./StatusIndicator";
import type { StackChild, StackPosition } from "@shared/pullRequestStack";
import { useWorktreeRowState } from "./useWorktreeRowState";

interface WorktreeRowProps {
  worktree: Worktree;
  // The peer device a peer's worktree lives on, for its badge at the
  // trailing edge. Absent, the worktree is this machine's.
  device?: SidebarDeviceBadge;
  // The peer this worktree is mirrored with, when it is: the row then
  // stands for both copies and wears the peer's badge.
  mirror?: SidebarDeviceBadge;
  pr: PullRequest | undefined;
  // Both off the tree builder, which places the project's rows by
  // stack once (buildSidebarRows).
  stack: StackPosition | null;
  stackChild?: StackChild;
}

// The row button's shell, worn by this machine's worktrees and a peer's
// alike so a peer's worktree reads as a sibling of a local one -- and
// stays one through the next restyle.
export const WORKTREE_ROW_BUTTON =
  "group relative flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent/60";

// The two-line branch-over-name block both row flavors lead with, faded
// back for a shelved worktree. `deviceId` names the peer a remote row's
// worktree lives on.
function WorktreeRowLabel({
  worktree,
  emphasized = false,
  deviceId,
}: {
  worktree: Worktree;
  emphasized?: boolean;
  deviceId?: string;
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
      <span className="flex min-w-0 items-center gap-1 text-3xs text-muted-foreground">
        <span className="truncate">{worktree.name}</span>
        <BirthdayBadge worktree={worktree} deviceId={deviceId} />
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

function stackIndentStyle(
  child: StackChild | undefined,
): CSSProperties | undefined {
  if (!child) return undefined;
  return {
    marginLeft: STACK_CHILD_INSET_PX,
    width: `calc(100% - ${STACK_CHILD_INSET_PX}px)`,
  };
}

function StackConnector({ child }: { child: StackChild | undefined }) {
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

// A worktree in the sidebar tree, this machine's or a peer device's. A
// peer's row keeps the local layout (branch over name, trailing status
// cluster) plus a device badge at the trailing edge. Everything else
// reads as local: the PR pill off the peer's own map, a delete
// dispatched to the peer from here off that device's mutation, script
// activity off its run store. It opens the worktree's own detail page
// under its device's route, exactly like clicking a local row. An
// unreachable device's rows fade back: last known state, not
// an error.
export function WorktreeRow({
  worktree,
  device,
  mirror,
  pr,
  stack,
  stackChild,
}: WorktreeRowProps) {
  // A peer's row takes the local row's own rule, scoped to the device:
  // the open remote worktree reads as selected like a local one.
  const { isSelected, open, activity, isDeleting, title } = useWorktreeRowState(
    worktree,
    device?.deviceId,
  );

  return (
    <button
      type="button"
      onClick={open}
      title={title}
      className={cn(
        WORKTREE_ROW_BUTTON,
        isSelected && "bg-accent text-accent-foreground",
        device
          ? (isDeleting || !device.reachable) && "opacity-60"
          : isDeleting && "opacity-50",
      )}
      style={stackIndentStyle(stackChild)}
    >
      <StackConnector child={stackChild} />
      <WorktreeRowLabel
        worktree={worktree}
        emphasized={isSelected}
        deviceId={device?.deviceId}
      />
      <RowTrailing
        worktree={worktree}
        activity={activity}
        isDeleting={isDeleting}
        pr={pr}
        stack={stack}
      />
      {mirror && <MirrorBadge mirror={mirror} />}
      {/* Rightmost, where the local row keeps its own trailing cluster:
          the owning device, name in the tooltip. */}
      {device && <DeviceBadge badge={device} />}
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
  // Resolved by the tree builder: the local one off its project's map,
  // a peer's off the map that came with its forest.
  pr: PullRequest | undefined;
  // The PR's place in its stack, off the same map.
  stack?: StackPosition | null;
}

// The right-edge cluster, the same for a peer's row so it keeps the
// same marks through the next restyle. Deletion takes the
// whole row (the worktree is going away, so the trash standing alone
// reads as "destroying"); a running script just adds a leading activity
// icon to the normal cluster so status / PR / kind stay visible.
function RowTrailing({
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
