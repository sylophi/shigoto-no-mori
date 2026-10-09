import { describePullRequest } from "@/lib/pullRequest";
import { cn } from "@/lib/utils";
import { TONE_TEXT } from "@/components/worktreeDetail/pullRequests/pullRequestShared";
import type { SidebarDeviceBadge } from "./DeviceBadgeView";
import type { GroupShelf } from "./sidebarRow";
import type { PullRequest, Worktree } from "@shigomori/contracts/schemas";
import type { StackPosition, StackRail } from "@shared/pullRequestStack";
import type { WorktreeEntry } from "./useWorktreeEntry";
import { WorktreeEntryView } from "./WorktreeEntryView";

export interface WorktreeRowProps {
  worktree: Worktree;
  // The peer device a peer's worktree lives on, for its badge beside
  // the worktree's name. Absent, the worktree is this machine's.
  device?: SidebarDeviceBadge;
  // The peer this worktree is mirrored with, when it is: the row then
  // stands for both copies and wears the peer's badge.
  mirror?: SidebarDeviceBadge;
  // The peer's copy, whose page selects this row too.
  mirrorWorktreeId?: string;
  pr: PullRequest | undefined;
  // Both off the tree builder, which places the project's rows by
  // stack once (buildSidebarRows).
  stack: StackPosition | null;
  stackRail?: StackRail;
  shelf: GroupShelf | null;
}

// A stack's rows draw as a rail through its layers, top layer first,
// the way a git graph draws a branch: every layer a stop on one line,
// in its PR's color, so the stack reads as one chain rather than a
// parent with children. Each stop's left edge sits on the column
// every other row's title starts at, and the stack's rows step in past
// the rail, so their hover and selection never reach over it. The rail
// is filled strips rather than a border: doubutsu clears every border
// color, and a rail that vanished with the theme would leave the stops
// floating. Its text size is the title's, so `lh` is the title line's
// height, and each stop sits on that line.
const RAIL_STOP_Y = "top-[calc(--spacing(1.5)+0.5lh)]";

function StackRailMark({
  rail,
  pr,
}: {
  rail: StackRail | undefined;
  pr: PullRequest | undefined;
}) {
  if (!rail) return null;
  const tone = pr ? describePullRequest(pr).tone : "slate";
  return (
    <span aria-hidden className="absolute inset-y-0 -left-2 text-xs">
      {/* Each stop but the last draws the rail down to the next, across
          its row and the gap under it (--row-gap), since every stop
          sits at the same height in its row. The pieces meet under a
          stop: rows sit on fractional pixels, and pieces meeting in the
          open would show a seam, or a darker line where they overlap.
          A 1px mid-tone line, on whole pixels: off the grid it blurs or
          snaps to another width. */}
      {!rail.last && (
        <span
          className={cn(
            "absolute left-0 h-[calc(100%+var(--row-gap,0px))] w-px bg-muted-foreground/45",
            RAIL_STOP_Y,
          )}
        />
      )}
      {/* Centered on the line by margins of half its size, not a
          translate: Chrome can snap a translated layer to a whole pixel
          when it paints, which set the stop half a pixel off the line.
          An odd size, so the stop and the 1px line share a center on
          whole pixels. */}
      <span
        className={cn(
          "absolute left-[0.5px] -mt-(--stop-r) -ml-(--stop-r) size-1.25 rounded-full bg-current [--stop-r:--spacing(0.625)]",
          RAIL_STOP_Y,
          TONE_TEXT[tone],
        )}
      />
    </span>
  );
}

// A worktree in the sidebar tree, this machine's or a peer device's:
// the inbox's row without its context line of project and time, since
// the tree shows one project at a time (WorktreeEntry). A peer's row is
// the same row plus its device badge. Everything else reads as local:
// the PR off the peer's own map, script activity off its run store,
// and a click opens the worktree's page under its device's route
// (WorktreeRow reads them, useWorktreeEntry).
export function WorktreeRowView({
  worktree,
  device,
  mirror,
  pr,
  stack,
  stackRail,
  shelf,
  entry,
}: Omit<WorktreeRowProps, "mirrorWorktreeId"> & { entry: WorktreeEntry }) {
  return (
    <WorktreeEntryView
      worktree={worktree}
      pr={pr}
      stack={stack}
      device={device}
      mirror={mirror}
      look={entry.look}
      onOpen={entry.open}
      resident={entry.resident}
      forwardTip={entry.forwardTip}
      marks={entry.marks}
      shelf={shelf}
      hideStackPosition={stackRail?.whole}
      className={cn(stackRail && "ml-4.5 w-[calc(100%-var(--spacing)*4.5)]")}
    >
      <StackRailMark rail={stackRail} pr={pr} />
    </WorktreeEntryView>
  );
}
