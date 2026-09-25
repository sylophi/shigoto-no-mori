import { useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import type { Project } from "@shared/schemas";
import { DeviceBadgeCluster, type SidebarDeviceBadge } from "./DeviceBadge";
import {
  ProjectGroupActions,
  useGroupMembers,
  type GroupMember,
} from "./ProjectGroupActions";
import { ProjectHeader } from "./ProjectHeader";
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
  expanded: boolean;
  // Peer devices whose worktrees merged into this project's group, and
  // their checkouts: the header's badges, and the extra devices its
  // actions can reach.
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
  devices,
  members,
  onToggle,
  arrangeMode,
  isHovered,
}: ProjectRowProps) {
  // Terrier-sourced projects have no registry entry, so there is no
  // stored order to drag them within: they always trail the list. A
  // peer's project has none here either.
  const fromTerrier = project.source === "terrier";
  // One flag behind both the drag and the affordance, so a row can't
  // advertise a grab it will refuse.
  const reorderable = arrangeMode && local && !fromTerrier;
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
  // This machine first, then every peer holding the same repo.
  const group = useGroupMembers(members, local ? project : undefined);
  const iconMember = useIconMember(group, local);
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
    <div
      ref={setNodeRef}
      style={sortableStyle}
      className={cn("relative rounded-md", isDragging && "opacity-0")}
      {...attributes}
    >
      <div className="flex items-center gap-0.5 py-0.5">
        <ProjectHeader
          project={project}
          iconFrom={
            iconMember && {
              projectId: iconMember.project.id,
              deviceId: iconMember.deviceId,
            }
          }
          badges={<DeviceBadgeCluster devices={devices} />}
          missing={missing}
          expanded={expanded}
          onToggle={onToggle}
          listeners={listeners}
          onContextMenu={onHeaderContextMenu}
          arrangeMode={arrangeMode}
          reorderable={reorderable}
        />
        {!arrangeMode && (
          <ProjectGroupActions
            name={project.name}
            identity={project.identity}
            members={group}
            isHovered={isHovered}
            triggerRef={triggerRef}
          />
        )}
      </div>
    </div>
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
