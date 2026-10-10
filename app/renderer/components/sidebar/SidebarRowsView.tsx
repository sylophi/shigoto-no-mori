// The forest's list as the virtualizer lays it out (SidebarList): the
// list's box, each row at its offset, and the rows that stand for a
// listing still on its way or one that failed.
import type { ReactNode, Ref } from "react";
import { Skeleton } from "@shigomori/ui/primitives/skeleton.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { ARRIVE_FROM } from "./sidebarChrome";
import { ROW_LAYOUT, type SidebarRow } from "./sidebarRow";

export function SidebarListView({
  listRef,
  height,
  arriveFrom,
  children,
}: {
  listRef?: Ref<HTMLDivElement>;
  // The virtualizer's total, which the rows are placed inside.
  height?: number;
  // A move made in the sidebar between the list of projects and one
  // project plays the rows in from that side.
  arriveFrom?: "left" | "right";
  children: ReactNode;
}) {
  return (
    <div
      ref={listRef}
      className={cn("relative", arriveFrom && ARRIVE_FROM[arriveFrom])}
      style={height === undefined ? undefined : { height: `${height}px` }}
    >
      {children}
    </div>
  );
}

// A row at its place in the list, which keeps its project's actions up
// while the cursor is on it (VirtualRow says whose).
export function VirtualRowView({
  row,
  index,
  start,
  measureRef,
  onHover,
  onLeave,
  children,
}: {
  row: SidebarRow;
  index: number;
  // Its offset from the list's top. Unset, the row sits in the flow.
  start?: number;
  measureRef?: (node: Element | null) => void;
  onHover?: () => void;
  onLeave?: () => void;
  // The row (RowContent).
  children: ReactNode;
}) {
  return (
    <div
      data-index={index}
      data-slot="sidebar-row"
      ref={measureRef}
      className={cn(
        start !== undefined && "absolute top-0 left-0 w-full",
        ROW_LAYOUT[row.kind],
        row.kind === "project" && row.pinnedEnd && "pb-3",
        // Inline, a gap over each project parts it from the one before.
        row.kind === "project" && row.folded !== undefined && "pt-1",
      )}
      style={
        start === undefined
          ? undefined
          : { transform: `translateY(${start}px)` }
      }
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
    >
      {children}
    </div>
  );
}

// A project whose worktrees are still listing.
export function WorktreesLoadingView() {
  return (
    <div className="space-y-1 px-2 py-1.5" aria-label="Loading worktrees">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-4 w-24" />
    </div>
  );
}

export function WorktreesErrorView() {
  return (
    <div className="px-2 py-1 text-xs text-muted-foreground">
      Couldn't load worktrees.
    </div>
  );
}
