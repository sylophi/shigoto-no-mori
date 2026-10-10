import { assertNever } from "@shigomori/ui/lib/utils.ts";
import { InboxRow } from "./inbox/InboxRow";
import { FoldHeaderView } from "@shigomori/ui/views/sidebar/FoldHeaderView.tsx";
import { ProjectRow } from "./ProjectRow";
import { ShelfRowView } from "@shigomori/ui/views/sidebar/ShelfRowView.tsx";
import { WorktreeRow } from "./WorktreeRow";
import {
  WorktreesErrorView,
  WorktreesLoadingView,
} from "@shigomori/ui/views/sidebar/SidebarRowsView.tsx";
import type {
  GroupShelf,
  InboxShelf,
  SidebarRow,
} from "@shigomori/ui/views/sidebar/sidebarRow.ts";

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
        <FoldHeaderView
          label={row.label}
          count={row.count}
          expanded={row.expanded}
          onToggle={() => onToggleOwner(row.ownerKey)}
        />
      );
    case "worktree-group":
      return (
        <FoldHeaderView
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
      return <WorktreesLoadingView />;
    case "group-shelf":
      return (
        <ShelfRowView
          shelf={row.shelf}
          count={row.count}
          expanded={row.expanded}
          onToggle={() => onToggleShelved(row.groupId, row.shelf)}
        />
      );
    case "inbox-shelf":
      return (
        <ShelfRowView
          shelf={row.shelf}
          count={row.count}
          expanded={row.expanded}
          onToggle={() => onToggleShelf(row.shelf)}
        />
      );
    case "inbox-group":
      return (
        <FoldHeaderView
          label={row.prefix}
          count={row.count}
          expanded={row.expanded}
          onToggle={() => onToggleInboxGroup(row.prefix)}
        />
      );
    case "worktree-error":
      return <WorktreesErrorView />;
    default:
      return assertNever(row);
  }
}
