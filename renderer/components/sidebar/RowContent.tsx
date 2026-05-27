import { Skeleton } from "@/components/ui/skeleton";
import { assertNever } from "@/lib/utils";
import { ProjectRow } from "./ProjectRow";
import { ShelvedToggleRow } from "./ShelvedToggleRow";
import { WorktreeRow } from "./WorktreeRow";
import type { SidebarRow } from "./sidebarRow";

interface RowContentProps {
  row: SidebarRow;
  onToggle: (projectId: string) => void;
  onToggleShelved: (projectId: string) => void;
  arrangeMode: boolean;
  isHovered: boolean;
}

export function RowContent({
  row,
  onToggle,
  onToggleShelved,
  arrangeMode,
  isHovered,
}: RowContentProps) {
  switch (row.kind) {
    case "project":
      return (
        <ProjectRow
          project={row.project}
          expanded={row.expanded}
          onToggle={() => onToggle(row.project.id)}
          arrangeMode={arrangeMode}
          isHovered={isHovered}
        />
      );
    case "worktree":
      return <WorktreeRow worktree={row.worktree} />;
    case "worktree-skeleton":
      return (
        <div className="space-y-1 px-2 py-1.5" aria-label="Loading worktrees">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      );
    case "shelved-toggle":
      return (
        <ShelvedToggleRow
          count={row.count}
          expanded={row.expanded}
          onToggle={() => onToggleShelved(row.projectId)}
        />
      );
    case "worktree-error":
      return (
        <div className="px-2 py-1 text-xs text-muted-foreground">
          Couldn't load worktrees.
        </div>
      );
    default:
      return assertNever(row);
  }
}
