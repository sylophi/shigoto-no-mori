import { Skeleton } from "@/components/ui/skeleton";
import { assertNever } from "@/lib/utils";
import { InboxRow } from "./inbox/InboxRow";
import { InboxShelfRow } from "./inbox/InboxShelfRow";
import { ProjectRow } from "./ProjectRow";
import { RemoteWorktreeRow } from "./RemoteWorktreeRow";
import { ShelvedToggleRow } from "./ShelvedToggleRow";
import { WorktreeRow } from "./WorktreeRow";
import type { InboxShelf, SidebarRow } from "./sidebarRow";

interface RowContentProps {
  row: SidebarRow;
  onToggle: (groupId: string) => void;
  onToggleShelved: (groupId: string) => void;
  onToggleShelf: (shelf: InboxShelf) => void;
  arrangeMode: boolean;
  isHovered: boolean;
}

export function RowContent({
  row,
  onToggle,
  onToggleShelved,
  onToggleShelf,
  arrangeMode,
  isHovered,
}: RowContentProps) {
  switch (row.kind) {
    case "project":
      return (
        <ProjectRow
          project={row.project}
          local={row.local}
          groupId={row.groupId}
          expanded={row.expanded}
          devices={row.devices}
          members={row.members}
          onToggle={() => onToggle(row.groupId)}
          arrangeMode={arrangeMode}
          isHovered={isHovered}
        />
      );
    case "worktree":
      return (
        <WorktreeRow
          worktree={row.worktree}
          mirror={row.mirror}
          stackRail={row.stackRail}
        />
      );
    case "remote-worktree":
      return (
        <RemoteWorktreeRow
          worktree={row.worktree}
          deviceId={row.deviceId}
          deviceLabel={row.deviceLabel}
          deviceIcon={row.deviceIcon}
          reachable={row.reachable}
          tone={row.tone}
          pr={row.pr}
          stack={row.stack}
          stackRail={row.stackRail}
        />
      );
    case "inbox-worktree":
      return (
        <InboxRow
          worktree={row.worktree}
          project={row.project}
          pr={row.pr}
          stack={row.stack}
          device={row.device}
          mirror={row.mirror}
        />
      );
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
          onToggle={() => onToggleShelved(row.groupId)}
        />
      );
    case "inbox-shelf":
      return (
        <InboxShelfRow
          shelf={row.shelf}
          count={row.count}
          expanded={row.expanded}
          onToggle={() => onToggleShelf(row.shelf)}
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
