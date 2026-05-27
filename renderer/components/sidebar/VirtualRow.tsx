import type { Dispatch, SetStateAction } from "react";
import { cn } from "@/lib/utils";
import { RowContent } from "./RowContent";
import type { SidebarRow } from "./sidebarRow";

interface VirtualRowProps {
  row: SidebarRow;
  index: number;
  start: number;
  measureRef: (node: Element | null) => void;
  hoveredProjectId: string | null;
  setHoveredProjectId: Dispatch<SetStateAction<string | null>>;
  onToggle: (projectId: string) => void;
  onToggleShelved: (projectId: string) => void;
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
  arrangeMode,
}: VirtualRowProps) {
  const rowProjectId = projectIdForRow(row);
  return (
    <div
      data-index={index}
      ref={measureRef}
      className={cn(
        "absolute top-0 left-0 w-full px-2",
        row.kind !== "project" && "pl-5",
      )}
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
        arrangeMode={arrangeMode}
        isHovered={hoveredProjectId === rowProjectId}
      />
    </div>
  );
}

function projectIdForRow(row: SidebarRow): string {
  if (row.kind === "project") return row.project.id;
  if (row.kind === "worktree") return row.worktree.projectId;
  return row.projectId;
}
