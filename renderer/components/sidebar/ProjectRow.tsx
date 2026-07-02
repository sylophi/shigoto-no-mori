import { useRef } from "react";
import { Loader2, MoreHorizontal, Plus } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useCreateWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useRemoveProject } from "@/hooks/projects/useProjects";
import type { Project } from "@shared/schemas";
import { ProjectHeader } from "./ProjectHeader";

interface ProjectRowProps {
  project: Project;
  expanded: boolean;
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
  onToggle,
  arrangeMode,
  isHovered,
}: ProjectRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id, disabled: !arrangeMode });
  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const navigate = useNavigate();
  const missing = project.pathExists === false;
  const removeProject = useRemoveProject();
  const create = useCreateWorktree();
  // Two-step confirm so accidentally landing on "Remove" doesn't drop the
  // project. Menu stays open while armed; second click within the timeout
  // fires the actual remove. The arm is cleared whenever the dropdown
  // closes so a leftover armed state can't fire on the next open.
  const {
    armed: removeArmed,
    trigger: triggerRemove,
    reset: resetRemoveArm,
  } = useConfirmTwice(CONFIRM_QUICK_MS);
  const onMenuOpenChange = (open: boolean) => {
    if (!open) resetRemoveArm();
  };
  // Right-clicking the header pops the same dropdown anchored to the
  // `…` button. Synthesizing a click on the trigger reuses base-ui's
  // normal open flow, which avoids the stray-pointer behavior we'd get
  // by toggling a controlled `open` prop ourselves.
  const triggerRef = useRef<HTMLButtonElement>(null);

  const onHeaderContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    triggerRef.current?.click();
  };

  const quickCreate = async () => {
    if (create.isPending) return;
    try {
      const defaultBranch = await window.api.projects.defaultBranch(project.id);
      const { worktree } = await create.mutateAsync({
        projectId: project.id,
        base: defaultBranch,
      });
      void navigate({
        to: "/projects/$projectId/worktrees/$worktreeId",
        params: { projectId: project.id, worktreeId: worktree.id },
      });
    } catch (err) {
      if (!create.isError) {
        notifyError("Couldn't resolve default branch", err);
      }
    }
  };

  const triggerButton = (
    <DropdownMenuTrigger
      render={
        <button
          ref={triggerRef}
          type="button"
          aria-label={`More actions for ${project.name}`}
          className={cn(
            "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground aria-expanded:opacity-100",
            isHovered ? "opacity-100" : "opacity-0",
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      }
    />
  );

  const removeItem = (
    <DropdownMenuItem
      variant="destructive"
      closeOnClick={removeArmed}
      onClick={(event) => {
        if (!removeArmed) event.preventDefault();
        triggerRemove(() => removeProject.mutate(project.id));
      }}
    >
      {removeArmed ? "Click again to confirm" : "Remove"}
    </DropdownMenuItem>
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
          missing={missing}
          expanded={expanded}
          onToggle={onToggle}
          listeners={listeners}
          onContextMenu={onHeaderContextMenu}
          arrangeMode={arrangeMode}
        />
        {!arrangeMode && (
          <>
            {!missing && (
              <button
                type="button"
                onClick={(e) => {
                  if (e.shiftKey || e.metaKey) {
                    void navigate({
                      to: "/projects/$projectId/new",
                      params: { projectId: project.id },
                    });
                    return;
                  }
                  void quickCreate();
                }}
                disabled={create.isPending}
                aria-label={`Quick-create worktree in ${project.name}`}
                title={`Quick-create worktree in ${project.name}`}
                className={cn(
                  "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-100 aria-busy:opacity-100",
                  isHovered ? "opacity-100" : "opacity-0",
                )}
                aria-busy={create.isPending}
              >
                {create.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Plus className="size-3.5" />
                )}
              </button>
            )}
            <DropdownMenu onOpenChange={onMenuOpenChange}>
              {triggerButton}
              <DropdownMenuContent align="end" sideOffset={2}>
                {!missing && (
                  <>
                    <DropdownMenuItem
                      disabled={create.isPending}
                      onClick={() => void quickCreate()}
                    >
                      Quick create
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        void navigate({
                          to: "/projects/$projectId/new",
                          params: { projectId: project.id },
                        })
                      }
                    >
                      New worktree from…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() =>
                        void navigate({
                          to: "/projects/$projectId/convert-external",
                          params: { projectId: project.id },
                        })
                      }
                    >
                      Convert external worktrees
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        void navigate({
                          to: "/projects/$projectId/worktree-location",
                          params: { projectId: project.id },
                        })
                      }
                    >
                      Set worktree location
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        void navigate({
                          to: "/projects/$projectId/branches",
                          params: { projectId: project.id },
                        })
                      }
                    >
                      Manage branches
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() =>
                        void navigate({
                          to: "/projects/$projectId/configure",
                          params: { projectId: project.id },
                        })
                      }
                    >
                      Configure
                    </DropdownMenuItem>
                  </>
                )}
                {removeItem}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </div>
  );
}
