import { Skeleton } from "@/components/ui/skeleton";
import { assertNever } from "@/lib/utils";
import { InboxRow } from "./inbox/InboxRow";
import { InboxShelfRow } from "./inbox/InboxShelfRow";
import { FoldHeader } from "./FoldHeader";
import { ProjectRow } from "./ProjectRow";
import { ShelvedToggleRow } from "./ShelvedToggleRow";
import { WorktreeRow } from "./WorktreeRow";
import type { GroupShelf, InboxShelf, SidebarRow } from "./sidebarRow";

interface RowContentProps {
  row: SidebarRow;
  onToggle: (groupKey: string) => void;
  onToggleShelved: (groupId: string, shelf: GroupShelf) => void;
  onToggleShelf: (shelf: InboxShelf) => void;
  onToggleOwner: (ownerKey: string) => void;
  onToggleWorktreeGroup: (groupId: string, prefix: string) => void;
  onToggleInboxGroup: (prefix: string) => void;
  currentGroupKey: string | undefined;
  arrangeMode: boolean;
  isHovered: boolean;
}

export function RowContent({
  row,
  onToggle,
  onToggleShelved,
  onToggleShelf,
  onToggleOwner,
  onToggleWorktreeGroup,
  onToggleInboxGroup,
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
          groupKey={row.groupKey}
          pinned={row.pinned}
          expanded={row.expanded}
          folded={row.folded}
          current={row.groupKey === currentGroupKey}
          branches={row.branches}
          devices={row.devices}
          members={row.members}
          onToggle={() => onToggle(row.groupKey)}
          arrangeMode={arrangeMode}
          isHovered={isHovered}
        />
      );
    case "owner-header":
      return (
        <FoldHeader
          label={row.label}
          count={row.count}
          expanded={row.expanded}
          onToggle={() => onToggleOwner(row.ownerKey)}
        />
      );
    case "worktree-group":
      return (
        <FoldHeader
          label={row.prefix}
          count={row.count}
          expanded={row.expanded}
          onToggle={() => onToggleWorktreeGroup(row.groupId, row.prefix)}
        />
      );
    case "worktree":
      return (
        <WorktreeRow
          worktree={row.worktree}
          mirror={row.mirror}
          mirrorWorktreeId={row.mirrorWorktreeId}
          pr={row.pr}
          stack={row.stack}
          stackRail={row.stackRail}
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
          stackRail={row.stackRail}
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
          mirrorWorktreeId={row.mirrorWorktreeId}
          shelf={row.shelf}
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
    case "inbox-group":
      return (
        <FoldHeader
          label={row.prefix}
          count={row.count}
          expanded={row.expanded}
          onToggle={() => onToggleInboxGroup(row.prefix)}
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
