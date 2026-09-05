import { useVirtualizer } from "@tanstack/react-virtual";
import { useLocation } from "@tanstack/react-router";
import { matchRoutePath, WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ROW_SIZE_HINTS,
  type SidebarRow,
  type SidebarViewModel,
} from "./sidebarRow";
import { VirtualRow, type RowHandlers } from "./VirtualRow";

interface SidebarListProps {
  rows: SidebarRow[];
  revealKey: SidebarViewModel["revealKey"];
  viewportRef: RefObject<HTMLDivElement | null>;
  handlers: RowHandlers;
}

// Owns the virtualizer, and only the virtualizer: useVirtualizer opts
// its enclosing component out of React Compiler memoization and
// re-renders it on every scroll offset. Isolating it here keeps
// Sidebar's row-model build memoized.
// The worktree an open detail page shows, local or on a peer.
function matchWorktreeDetail(pathname: string): {
  deviceId?: string;
  projectId: string;
  worktreeId: string;
} | null {
  const remote = matchRoutePath(WORKTREE_ROUTE_PATHS.detail.remote, pathname);
  if (remote) {
    return {
      deviceId: remote.deviceId!,
      projectId: remote.projectId!,
      worktreeId: remote.worktreeId!,
    };
  }
  const local = matchRoutePath(WORKTREE_ROUTE_PATHS.detail.local, pathname);
  return local
    ? { projectId: local.projectId!, worktreeId: local.worktreeId! }
    : null;
}

export function SidebarList({
  rows,
  revealKey,
  viewportRef,
  handlers,
}: SidebarListProps) {
  // Tracks the project the cursor is over (header row OR one of its
  // children) so ProjectRow keeps its actions visible. Lives here, not in
  // Sidebar: a hover only ever repaints rows.
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => ROW_SIZE_HINTS[rows[index]?.kind ?? "worktree"],
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  // The virtualizer reads its scroll element on every render, but the
  // ref belongs to the ScrollArea viewport, an ancestor, and React
  // attaches an ancestor's ref after this component's layout effects:
  // on the mount pass the virtualizer sees null and lays out no rows.
  // A second render heals it, and on a cold cache the queries landing
  // provide one. With a warm cache (the phone layout's forest page
  // remounting on every tab switch) nothing would, and the forest
  // stays blank. One passive effect after the commit re-renders once
  // with the element in hand.
  const [, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Reveal the selection when navigation comes from outside the sidebar
  // (launcher jump, empty-state redirect) by scrolling the virtualized
  // list to whichever row the active view says stands for it. The row can
  // lag the route (worktree queries still loading), so this retries every
  // render until it exists; the ref stops repeat scrolls afterwards so
  // the user can still scroll away freely.
  // Both detail routes: the local one and its device-scoped twin, so a
  // peer's worktree is revealed too.
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
      className="relative"
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
