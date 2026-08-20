import { useVirtualizer } from "@tanstack/react-virtual";
import { useLocation } from "@tanstack/react-router";
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

  // Reveal the selection when navigation comes from outside the sidebar
  // (launcher jump, empty-state redirect) by scrolling the virtualized
  // list to whichever row the active view says stands for it. The row can
  // lag the route (worktree queries still loading), so this retries every
  // render until it exists; the ref stops repeat scrolls afterwards so
  // the user can still scroll away freely.
  const { pathname } = useLocation();
  const selectedMatch = pathname.match(
    /^\/projects\/([^/]+)\/worktrees\/([^/]+)$/,
  );
  const lastRevealedRef = useRef<string | null>(null);
  useEffect(() => {
    const [, projectId, worktreeId] = selectedMatch ?? [];
    if (!projectId || !worktreeId) {
      lastRevealedRef.current = null;
      return;
    }
    if (lastRevealedRef.current === worktreeId) return;
    const key = revealKey(projectId, worktreeId);
    if (!key) return;
    const index = rows.findIndex((r) => r.key === key);
    if (index < 0) return;
    lastRevealedRef.current = worktreeId;
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
