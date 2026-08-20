import type { Dispatch, SetStateAction } from "react";
import { cn } from "@/lib/utils";
import { RowContent } from "./RowContent";
import { ROW_LAYOUT, type InboxShelf, type SidebarRow } from "./sidebarRow";

// What a row needs from the sidebar but this wrapper only forwards,
// grouped so VirtualRow's own props stay about positioning and hover.
export interface RowHandlers {
  onToggle: (projectId: string) => void;
  onToggleShelved: (projectId: string) => void;
  onToggleShelf: (shelf: InboxShelf) => void;
  arrangeMode: boolean;
}

interface VirtualRowProps {
  row: SidebarRow;
  index: number;
  start: number;
  measureRef: (node: Element | null) => void;
  hoveredProjectId: string | null;
  setHoveredProjectId: Dispatch<SetStateAction<string | null>>;
  handlers: RowHandlers;
}

export function VirtualRow({
  row,
  index,
  start,
  measureRef,
  hoveredProjectId,
  setHoveredProjectId,
  handlers,
}: VirtualRowProps) {
  const rowProjectId = projectIdForRow(row);
  return (
    <div
      data-index={index}
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
        {...handlers}
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
