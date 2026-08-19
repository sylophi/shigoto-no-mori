import type { Dispatch, SetStateAction } from "react";
import { cn } from "@/lib/utils";
import { RowContent } from "./RowContent";
import {
  isInboxRow,
  ROW_LAYOUT,
  type InboxShelf,
  type SidebarRow,
} from "./sidebarRow";

interface VirtualRowProps {
  row: SidebarRow;
  index: number;
  start: number;
  measureRef: (node: Element | null) => void;
  hoveredProjectId: string | null;
  setHoveredProjectId: Dispatch<SetStateAction<string | null>>;
  onToggle: (projectId: string) => void;
  onToggleShelved: (projectId: string) => void;
  onToggleShelf: (shelf: InboxShelf) => void;
  arrangeMode: boolean;
}

export function VirtualRow({
  row,
  index,
  start,
  measureRef,
  hoveredProjectId,
  setHoveredProjectId,
  onToggle,
  onToggleShelved,
  onToggleShelf,
  arrangeMode,
}: VirtualRowProps) {
  const rowProjectId = projectIdForRow(row);
  return (
    <div
      data-index={index}
      // See sidebar-inbox-item in doubutsu.css.
      data-slot={isInboxRow(row.kind) ? "sidebar-inbox-item" : undefined}
      ref={measureRef}
      className={cn("absolute top-0 left-0 w-full", ROW_LAYOUT[row.kind])}
      style={{ transform: `translateY(${start}px)` }}
      onMouseEnter={() => setHoveredProjectId(rowProjectId)}
      onMouseLeave={() =>
        setHoveredProjectId((cur) => (cur === rowProjectId ? null : cur))
      }
    >
      <RowContent
        row={row}
        onToggle={onToggle}
        onToggleShelved={onToggleShelved}
        onToggleShelf={onToggleShelf}
        arrangeMode={arrangeMode}
        isHovered={hoveredProjectId === rowProjectId}
      />
    </div>
  );
}

// Who a row's hover belongs to, so a ProjectRow can keep its actions up
// while the cursor is on one of its children. Only the tree has project
// headers to keep alive, so the inbox's rows -- which do their own
// hovering in CSS -- report to nobody rather than re-rendering the
// sidebar on every row the cursor crosses.
function projectIdForRow(row: SidebarRow): string | null {
  if (row.kind === "project") return row.project.id;
  if (row.kind === "worktree") return row.worktree.projectId;
  if (row.kind === "inbox-worktree" || row.kind === "inbox-shelf") return null;
  return row.projectId;
}
