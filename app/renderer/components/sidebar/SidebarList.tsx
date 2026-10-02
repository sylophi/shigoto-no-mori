import { useVirtualizer } from "@tanstack/react-virtual";
import { useLocation } from "@tanstack/react-router";
import {
  matchRoutePath,
  rowDeviceId,
  WORKTREE_ROUTE_PATHS,
} from "@/lib/routePaths";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  rowSizeHint,
  type SidebarRow,
  type SidebarViewModel,
} from "./sidebarRow";
import { VirtualRow, type RowHandlers } from "./VirtualRow";
import { isPhoneLayout } from "@/hooks/ui/useViewport";
import { cn } from "@/lib/utils";

interface SidebarListProps {
  rows: SidebarRow[];
  revealKey: SidebarViewModel["revealKey"];
  scrollerRef: RefObject<HTMLDivElement | null>;
  handlers: RowHandlers;
  level: Level;
  // The level was asked for in the sidebar (a project picked, the way
  // back taken) rather than reached by following the page on screen.
  asked: boolean;
}

// The view's level (SidebarViewModel): the open project's group key,
// null on the list of projects, undefined for a view with no levels.
type Level = SidebarViewModel["level"];

// Owns the virtualizer, and only the virtualizer: useVirtualizer opts
// its enclosing component out of React Compiler memoization and
// re-renders it on every scroll offset. Isolating it here keeps
// Sidebar's row-model build memoized.
// The worktree an open detail page shows, local or on a peer, its
// device spelled the way the rows spell it (none for this machine's).
function matchWorktreeDetail(pathname: string): {
  deviceId?: string;
  projectId: string;
  worktreeId: string;
} | null {
  const match = matchRoutePath(WORKTREE_ROUTE_PATHS.detail, pathname);
  if (!match) return null;
  const { deviceId, projectId, worktreeId } = match;
  if (
    deviceId === undefined ||
    projectId === undefined ||
    worktreeId === undefined
  ) {
    return null;
  }
  return { deviceId: rowDeviceId(deviceId), projectId, worktreeId };
}

export function SidebarList({
  rows,
  revealKey,
  scrollerRef,
  handlers,
  level,
  asked,
}: SidebarListProps) {
  // Tracks the project the cursor is over (header row OR one of its
  // children) so ProjectRow keeps its actions visible. Lives here, not in
  // Sidebar: a hover only ever repaints rows.
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (index) =>
      rowSizeHint(rows[index]?.kind ?? "worktree", isPhoneLayout()),
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  // The virtualizer reads its scroll element on every render, but the
  // ref belongs to the sidebar's scroller, an ancestor, and React
  // attaches an ancestor's ref after this component's layout effects:
  // on the mount pass the virtualizer sees null and lays out no rows.
  // A second render heals it, and on a cold cache the queries landing
  // provide one. With a warm cache (the phone layout's forest page
  // remounting on every tab switch) nothing would, and the forest
  // stays blank. One passive effect after the commit re-renders once
  // with the element in hand.
  const [, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // The level on screen and the one it was reached from, for the two
  // things a change of level does. Tracked in render, so both read the
  // same answer.
  const [shown, setShown] = useState<{ level: Level; left?: Level }>({
    level,
  });
  if (shown.level !== level) setShown({ level, left: shown.level });
  // A move between the tree's two levels, as opposed to the first
  // paint or a flip to or from the inbox.
  const moved = shown.left !== undefined && level !== undefined;
  // It starts the scroll over: a project opens at its top, and the list
  // comes back with the project just left in view, so the place the
  // list was read from is found again. Before the selection's reveal
  // below, which then has the last word on a worktree opened from
  // outside the sidebar.
  useEffect(() => {
    if (!moved) return;
    if (level !== null) {
      scrollerRef.current?.scrollTo({ top: 0 });
      return;
    }
    const index = rows.findIndex(
      (row) => row.kind === "project" && row.groupKey === shown.left,
    );
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
    // Keyed on the level alone: the rows and the virtualizer are new
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level]);

  // Reveal the selection when navigation comes from outside the sidebar
  // (a ⌘K jump, empty-state redirect) by scrolling the virtualized
  // list to whichever row the active view says stands for it. The row can
  // lag the route (worktree queries still loading), so this retries every
  // render until it exists; the ref stops repeat scrolls afterwards so
  // the user can still scroll away freely.
  // Any device's detail page, so a peer's worktree is revealed too.
  const { pathname } = useLocation();
  const open = matchWorktreeDetail(pathname);
  const lastRevealedRef = useRef<string | null>(null);
  useEffect(() => {
    const { deviceId, projectId, worktreeId } = open ?? {};
    if (!projectId || !worktreeId) {
      lastRevealedRef.current = null;
      return;
    }
    const revealed = `${deviceId ?? ""}:${worktreeId}`;
    if (lastRevealedRef.current === revealed) return;
    const key = revealKey(projectId, worktreeId, deviceId);
    if (!key) return;
    const index = rows.findIndex((r) => r.key === key);
    if (index < 0) return;
    lastRevealedRef.current = revealed;
    virtualizer.scrollToIndex(index, { align: "auto" });
  });

  return (
    <div
      // Remounted per level so the arrival plays again: going into a
      // project and back out in the sidebar is a move between two
      // places, so the rows arrive from the side they were gone to, a
      // project from the right and the list from the left. A level the
      // tree only followed the page to (a launch, a ⌘K jump) arrives
      // plainly: the move was made somewhere else.
      key={
        level === undefined ? "flat" : level === null ? "list" : `in:${level}`
      }
      className={cn(
        "relative",
        moved &&
          asked &&
          "animate-in duration-150 fade-in-0 motion-reduce:animate-none",
        moved &&
          asked &&
          (level === null ? "slide-in-from-left-2" : "slide-in-from-right-2"),
      )}
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const row = rows[vi.index];
        if (!row) return null;
        return (
          <VirtualRow
            key={row.key}
            row={row}
            index={vi.index}
            start={vi.start}
            measureRef={virtualizer.measureElement}
            hoveredProjectId={hoveredProjectId}
            setHoveredProjectId={setHoveredProjectId}
            handlers={handlers}
          />
        );
      })}
    </div>
  );
}
