import { useRef } from "react";
import { Loader2, MoreHorizontal, Plus } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import type { Project } from "@shared/schemas";
import { DeviceBadgeCluster, type SidebarDeviceBadge } from "./DeviceBadge";
import { ProjectHeader } from "./ProjectHeader";
import { ProjectMenuItems, useProjectMenuRemoveArm } from "./ProjectMenuItems";

interface ProjectRowProps {
  project: Project;
  expanded: boolean;
  // Peer devices whose worktrees merged into this project's group.
  devices: readonly SidebarDeviceBadge[];
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
  const {
    quickCreate,
    openCreateForm,
    isPending: creating,
  } = useQuickCreateWorktree();
  const { removeArm, onOpenChange } = useProjectMenuRemoveArm();
  // Right-clicking the header pops the same dropdown anchored to the
  // `…` button. Synthesizing a click on the trigger reuses base-ui's
  // normal open flow, which avoids the stray-pointer behavior we'd get
  // by toggling a controlled `open` prop ourselves.
  const triggerRef = useRef<HTMLButtonElement>(null);

  const onHeaderContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    triggerRef.current?.click();
  };

  const triggerButton = (
    <DropdownMenuTrigger
      render={
        <button
          ref={triggerRef}
          type="button"
          aria-label={`More actions for ${project.name}`}
          className={cn(
            "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground aria-expanded:opacity-100 phone:opacity-100",
            isHovered ? "opacity-100" : "opacity-0",
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      }
    />
  );

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
          <>
            {!missing && (
              <button
                type="button"
                onClick={(e) => {
                  if (e.shiftKey || e.metaKey || e.ctrlKey) {
                    openCreateForm(project.id);
                    return;
                  }
                  void quickCreate(project.id);
                }}
                disabled={creating}
                aria-label={`Quick-create worktree in ${project.name}`}
                title={`Quick-create worktree in ${project.name}`}
                className={cn(
                  "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-100 aria-busy:opacity-100 phone:opacity-100",
                  isHovered ? "opacity-100" : "opacity-0",
                )}
                aria-busy={creating}
              >
                {creating ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Plus className="size-3.5" />
                )}
              </button>
            )}
            <DropdownMenu onOpenChange={onOpenChange}>
              {triggerButton}
              <DropdownMenuContent align="end" sideOffset={2}>
                <ProjectMenuItems
                  project={project}
                  subject="project"
                  removeArm={removeArm}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </div>
  );
}
