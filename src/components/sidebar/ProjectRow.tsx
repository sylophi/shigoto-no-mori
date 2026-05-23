import { useRef } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/useConfirmTwice";
import { useCreateWorktree } from "@/hooks/useWorktrees";
import { useIsTruncated } from "@/hooks/useIsTruncated";
import { useRemoveProject } from "@/hooks/useProjects";
import type { Project } from "@shared/schemas";

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

  if (missing) {
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
            missing
            listeners={listeners}
            onContextMenu={onHeaderContextMenu}
            arrangeMode={arrangeMode}
          />
          {!arrangeMode && (
            <DropdownMenu onOpenChange={onMenuOpenChange}>
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
              <DropdownMenuContent align="end" sideOffset={2}>
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
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  }

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
          expanded={expanded}
          onToggle={onToggle}
          listeners={listeners}
          onContextMenu={onHeaderContextMenu}
          arrangeMode={arrangeMode}
        />
        {!arrangeMode && (
          <>
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
            <DropdownMenu onOpenChange={onMenuOpenChange}>
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
              <DropdownMenuContent align="end" sideOffset={2}>
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
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </div>
  );
}

interface ProjectHeaderProps {
  project: Project;
  expanded?: boolean;
  onToggle?: () => void;
  missing?: boolean;
  listeners?: DraggableSyntheticListeners;
  onContextMenu?: (event: React.MouseEvent) => void;
  arrangeMode?: boolean;
}

// Header row shared by the healthy and missing-project branches. The
// project name is `truncate`d, with a Tooltip that only opens when the
// text actually overflows — uses `useIsTruncated` to suppress redundant
// tooltips on names that already fit.
function ProjectHeader({
  project,
  expanded,
  onToggle,
  missing,
  listeners,
  onContextMenu,
  arrangeMode,
}: ProjectHeaderProps) {
  const [nameRef, isTruncated] = useIsTruncated<HTMLSpanElement>();
  const baseClass =
    "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-semibold tracking-wide uppercase";
  const trigger = arrangeMode ? (
    <div
      {...listeners}
      onContextMenu={onContextMenu}
      className={cn(
        baseClass,
        "cursor-grab text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing",
        missing && "text-muted-foreground/60 hover:text-muted-foreground",
      )}
    >
      {missing && (
        <AlertTriangle className="size-3 shrink-0 text-destructive/70" />
      )}
      <span
        ref={nameRef}
        className={cn(
          "min-w-0 truncate",
          missing && "line-through decoration-1",
        )}
      >
        {project.name}
      </span>
    </div>
  ) : missing ? (
    <div
      onContextMenu={onContextMenu}
      className={cn(baseClass, "text-muted-foreground/60")}
    >
      <AlertTriangle className="size-3 shrink-0 text-destructive/70" />
      <span
        ref={nameRef}
        className="min-w-0 truncate line-through decoration-1"
      >
        {project.name}
      </span>
      <span className="shrink-0 text-[10px] font-medium tracking-normal text-muted-foreground/60 normal-case">
        missing
      </span>
    </div>
  ) : (
    <button
      type="button"
      onClick={onToggle}
      onContextMenu={onContextMenu}
      className={cn(
        baseClass,
        "text-muted-foreground transition-colors hover:text-foreground",
      )}
    >
      <ChevronRight
        className={cn(
          "size-3 shrink-0 transition-transform",
          expanded && "rotate-90",
        )}
      />
      <span ref={nameRef} className="min-w-0 truncate">
        {project.name}
      </span>
    </button>
  );

  return (
    <TooltipProvider delay={400}>
      <Tooltip disabled={!isTruncated}>
        <TooltipTrigger render={trigger} />
        <TooltipContent>{project.name}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
