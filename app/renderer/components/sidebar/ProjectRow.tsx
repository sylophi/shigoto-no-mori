import { useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Project } from "@shigomori/contracts/schemas";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { useSidebarMarks } from "@/hooks/config/useSidebarMarks";
import {
  DeviceBadgeClusterView,
  type SidebarDeviceBadge,
} from "./DeviceBadgeView";
import { useLocateProject } from "./LocateProjectPicker";
import {
  ProjectGroupActions,
  useGroupMembers,
  useIconMember,
} from "./ProjectGroupActions";
import { ProjectHeaderView } from "./ProjectHeaderView";
import { ProjectRowView } from "./ProjectRowView";
import type { RemoteProjectMember } from "./sidebarRow";

interface ProjectRowProps {
  // This machine's checkout, or the first peer's when the repo is on
  // peers alone (`local` false). The row is the same either way: what
  // changes is only whose icon it reads and which devices its actions
  // reach.
  project: Project;
  local: boolean;
  // The group's id. A peer's project id can equal a local project's
  // (ids derive from the checkout path), so this is what stays unique
  // across the list.
  groupId: string;
  // What the group goes by (projectGroupKey), which its pin is kept by.
  groupKey: string;
  pinned: boolean;
  // The open project, alone in the tree: the row is its title. Else
  // the row is one of the list, to be picked.
  expanded: boolean;
  // On the inline list, whether the project is folded to the row,
  // which picking flips.
  folded: boolean | undefined;
  // The page on screen belongs to this project.
  current: boolean;
  // On the list, the worktrees the project holds beside its primary
  // checkouts.
  branches: number | undefined;
  // Peer devices whose worktrees merged into this project's group, and
  // their checkouts: the open header's badges, and the extra devices
  // its actions can reach.
  devices: readonly SidebarDeviceBadge[];
  members: readonly RemoteProjectMember[];
  onToggle: () => void;
  arrangeMode: boolean;
  // True while the cursor is anywhere in this project's region in the
  // sidebar (header row or any of its child worktree rows). Drives the
  // visibility of the inline action buttons.
  isHovered: boolean;
}

export function ProjectRow({
  project,
  local,
  groupId,
  groupKey,
  pinned,
  expanded,
  folded,
  current,
  branches,
  devices,
  members,
  onToggle,
  arrangeMode,
  isHovered,
}: ProjectRowProps) {
  // Only this machine's projects have a stored order to drag within, a
  // peer's has none here. One flag behind both the drag and the
  // affordance, so a row can't advertise a grab it will refuse.
  const reorderable = arrangeMode && local;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: groupId, disabled: !reorderable });
  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const marks = useSidebarMarks();
  const missing = project.pathExists === false;
  // One of the list, to go into.
  const pickable = !arrangeMode && !expanded && !missing;
  // This machine first, then every peer holding the same repo.
  const group = useGroupMembers(members, local ? project : undefined);
  const iconMember = useIconMember(group, local);
  const { relocating, onLocate, picker } = useLocateProject(
    group,
    project,
    missing,
  );
  // The header stands for the repo on every device, and terrier lists
  // it per device, so any checkout of it being terrier's marks it.
  // Only the open (or unfolded) project wears the paw, so only it
  // looks.
  const terrierInGroup =
    (expanded || folded === false) &&
    group.some((member) => member.project.source === "terrier");
  // Right-clicking the header pops the same dropdown anchored to the
  // `…` button. Synthesizing a click on the trigger reuses base-ui's
  // normal open flow, which avoids the stray-pointer behavior we'd get
  // by toggling a controlled `open` prop ourselves.
  const triggerRef = useRef<HTMLButtonElement>(null);

  const onHeaderContextMenu = (event: React.MouseEvent) => {
    // No trigger means no actions to show (every peer asleep), and the
    // native menu is better than none.
    if (triggerRef.current === null) return;
    event.preventDefault();
    triggerRef.current?.click();
  };

  return (
    <ProjectRowView
      sortable={{ setNodeRef, style: sortableStyle, attributes, isDragging }}
      arrangeMode={arrangeMode}
      pickable={pickable}
      current={current}
      folded={folded}
      branches={branches}
      isHovered={isHovered}
      header={
        <ProjectHeaderView
          project={project}
          icon={
            <ProjectIcon
              projectId={iconMember?.project.id ?? project.id}
              name={project.name}
              deviceId={iconMember?.deviceId}
            />
          }
          badges={
            marks.deviceBadges && <DeviceBadgeClusterView devices={devices} />
          }
          terrier={marks.terrier && terrierInGroup}
          pinned={pinned}
          missing={missing}
          relocating={relocating}
          onLocate={arrangeMode ? undefined : onLocate}
          expanded={expanded}
          folded={folded}
          current={current}
          onToggle={onToggle}
          listeners={listeners}
          onContextMenu={onHeaderContextMenu}
          arrangeMode={arrangeMode}
          reorderable={reorderable}
        />
      }
      actions={
        <ProjectGroupActions
          name={project.name}
          identity={project.identity}
          groupKey={groupKey}
          pinned={pinned}
          members={group}
          // The open project's row is the tree's title, and wears
          // its actions at rest.
          isHovered={isHovered || expanded}
          triggerRef={triggerRef}
          onLocate={onLocate}
          sortsWorktrees={folded !== undefined}
        />
      }
      picker={picker}
    />
  );
}
