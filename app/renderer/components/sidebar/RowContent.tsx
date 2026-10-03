import { assertNever } from "@/lib/utils";
import { InboxRow } from "./inbox/InboxRow";
import { InboxShelfRow } from "./inbox/InboxShelfRow";
import { ProjectRow } from "./ProjectRow";
import { WorktreeErrorRow, WorktreeSkeletonRow } from "./RowContentView";
import { ShelvedToggleRow } from "./ShelvedToggleRow";
import { WorktreeRow } from "./WorktreeRow";
import type { GroupShelf, InboxShelf, SidebarRow } from "./sidebarRow";

interface RowContentProps {
  row: SidebarRow;
  onToggle: (groupKey: string) => void;
  onToggleShelved: (groupId: string, shelf: GroupShelf) => void;
  onToggleShelf: (shelf: InboxShelf) => void;
  currentGroupKey: string | undefined;
  arrangeMode: boolean;
  isHovered: boolean;
}

export function RowContent({
  row,
  onToggle,
  onToggleShelved,
  onToggleShelf,
  currentGroupKey,
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
          current={row.groupKey === currentGroupKey}
          branches={row.branches}
          devices={row.devices}
          members={row.members}
          onToggle={() => onToggle(row.groupKey)}
          arrangeMode={arrangeMode}
          isHovered={isHovered}
        />
      );
    case "worktree":
      return (
        <WorktreeRow
          worktree={row.worktree}
          mirror={row.mirror}
          pr={row.pr}
          stack={row.stack}
          stackChild={row.stackChild}
          shelf={row.shelf}
        />
      );
    case "remote-worktree":
      return (
        <WorktreeRow
          worktree={row.worktree}
          device={row.device}
          pr={row.pr}
          stack={row.stack}
          stackChild={row.stackChild}
          shelf={row.shelf}
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
          shelf={row.shelf}
        />
      );
    case "worktree-skeleton":
      return <WorktreeSkeletonRow />;
    case "shelved-toggle":
      return (
        <ShelvedToggleRow
          shelf={row.shelf}
          count={row.count}
          expanded={row.expanded}
          onToggle={() => onToggleShelved(row.groupId, row.shelf)}
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
      return <WorktreeErrorRow />;
    default:
      return assertNever(row);
  }
}
