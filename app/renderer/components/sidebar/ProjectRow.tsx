import { useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Project } from "@shared/schemas";
import { DeviceBadgeCluster, type SidebarDeviceBadge } from "./DeviceBadge";
import {
  ProjectGroupActions,
  useGroupMembers,
  type GroupMember,
} from "./ProjectGroupActions";
import { ProjectHeader } from "./ProjectHeader";
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
  // The open project, alone in the tree: the row is its title. Else
  // the row is one of the list, to be picked.
  expanded: boolean;
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
  expanded,
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
  const missing = project.pathExists === false;
  // One of the list, to go into.
  const pickable = !arrangeMode && !expanded && !missing;
  // This machine first, then every peer holding the same repo.
  const group = useGroupMembers(members, local ? project : undefined);
  const iconMember = useIconMember(group, local);
  // The header stands for the repo on every device, and terrier lists
  // it per device, so any checkout of it being terrier's marks it.
  // Only the open project wears the paw, so only it looks.
  const terrierInGroup =
    expanded && group.some((member) => member.project.source === "terrier");
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
      sortable={{
        ref: setNodeRef,
        style: sortableStyle,
        // The sortable's marks belong to arranging alone. Outside it the
        // sortable is off, and its aria-disabled would put the
        // not-allowed cursor (index.css) on a row that is only a title,
        // and a tab stop on a wrapper with nothing to do.
        attributes: arrangeMode ? attributes : undefined,
        isDragging,
      }}
      pickable={pickable}
      current={current}
      branches={branches}
      isHovered={isHovered}
      arrangeMode={arrangeMode}
      header={
        <ProjectHeader
          project={project}
          iconFrom={
            iconMember && {
              projectId: iconMember.project.id,
              deviceId: iconMember.deviceId,
            }
          }
          badges={<DeviceBadgeCluster devices={devices} />}
          terrier={terrierInGroup}
          missing={missing}
          expanded={expanded}
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
          members={group}
          // The open project's row is the tree's title, and wears
          // its actions at rest.
          isHovered={isHovered || expanded}
          triggerRef={triggerRef}
        />
      }
    />
  );
}

// Whose icon a peer-only project shows: the repo's own, read from the
// first live member (projects:icon sits on the ungated read surface, so
// a read-only peer serves it). When every member is asleep the row
// keeps reading the member that last served it, because that is the
// key the cached icon lives under. A group that never had a live member
// reads its first. Undefined for a local project, which reads its own.
function useIconMember(
  group: readonly GroupMember[],
  local: boolean,
): GroupMember | undefined {
  const live = local
    ? undefined
    : group.find((member) => member.api !== undefined);
  // Kept by device id: the members are rebuilt every render.
  const [lastLiveId, setLastLiveId] = useState(live?.deviceId);
  if (live !== undefined && live.deviceId !== lastLiveId) {
    setLastLiveId(live.deviceId);
  }
  if (local) return undefined;
  return (
    live ?? group.find((member) => member.deviceId === lastLiveId) ?? group[0]
  );
}
