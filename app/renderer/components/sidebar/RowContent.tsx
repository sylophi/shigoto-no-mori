import { assertNever } from "@shigomori/ui/lib/utils.ts";
import { InboxRow } from "./inbox/InboxRow";
import { FoldHeaderView } from "@shigomori/ui/views/sidebar/FoldHeaderView.tsx";
import { ProjectFolderHeader } from "./ProjectFolder";
import { ProjectRow } from "./ProjectRow";
import { ShelfRowView } from "@shigomori/ui/views/sidebar/ShelfRowView.tsx";
import { WorktreeRow } from "./WorktreeRow";
import {
  WorktreesErrorView,
  WorktreesLoadingView,
} from "@shigomori/ui/views/sidebar/SidebarRowsView.tsx";
import type { SidebarRow } from "@shigomori/ui/views/sidebar/sidebarRow.ts";
import type { RowHandlers } from "./VirtualRow";

interface RowContentProps extends RowHandlers {
  row: SidebarRow;
  isHovered: boolean;
}

export function RowContent({
  row,
  onToggle,
  onToggleShelved,
  onToggleShelf,
  onToggleOwner,
  onToggleFolder,
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
          folder={row.folder}
          folders={row.folders}
          section={row.section}
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
    case "project-folder":
      return (
        <ProjectFolderHeader
          row={row}
          onToggle={() => onToggleFolder(row.foldKey)}
        />
      );
    case "worktree-group":
      return (
        <FoldHeaderView
          label={row.prefix}
          count={row.count}
          expanded={row.expanded}
          onToggle={() => onToggleWorktreeGroup(row.groupKey, row.prefix)}
        />
      );
    case "worktree":
      return (
        <WorktreeRow
          deviceId={row.deviceId}
          worktree={row.worktree}
          device={row.device}
          mirror={row.mirror}
          mirrorWorktreeId={row.mirrorWorktreeId}
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
          deviceId={row.deviceId}
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
          onToggle={() => onToggleShelved(row.groupKey, row.shelf)}
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
