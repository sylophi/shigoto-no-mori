import { useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import type { Project } from "@shared/schemas";
import { DeviceBadgeCluster, type SidebarDeviceBadge } from "./DeviceBadge";
import { ProjectGroupActions, useGroupMembers } from "./ProjectGroupActions";
import { ProjectHeader } from "./ProjectHeader";
import type { RemoteProjectMember } from "./sidebarRow";

interface ProjectRowProps {
  project: Project;
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
  expanded,
  devices,
  members,
  onToggle,
  arrangeMode,
  isHovered,
}: ProjectRowProps) {
  // Terrier-sourced projects have no registry entry, so there is no
  // stored order to drag them within: they always trail the list.
  const fromTerrier = project.source === "terrier";
  // One flag behind both the drag and the affordance, so a row can't
  // advertise a grab it will refuse.
  const reorderable = arrangeMode && !fromTerrier;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id, disabled: !reorderable });
  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const missing = project.pathExists === false;
  // This machine first, then every peer holding the same repo.
  const group = useGroupMembers(members, project);
  // Right-clicking the header pops the same dropdown anchored to the
  // `…` button. Synthesizing a click on the trigger reuses base-ui's
  // normal open flow, which avoids the stray-pointer behavior we'd get
  // by toggling a controlled `open` prop ourselves.
  const triggerRef = useRef<HTMLButtonElement>(null);

  const onHeaderContextMenu = (event: React.MouseEvent) => {
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
