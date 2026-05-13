import { useState } from "react";
import { ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useSelection } from "@/hooks/useSelection";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useRemoveProject } from "@/hooks/useProjects";
import type { Project } from "@shared/types";
import { WorktreeRow } from "./WorktreeRow";

interface ProjectGroupProps {
  project: Project;
}

export function ProjectGroup({ project }: ProjectGroupProps) {
  const [expanded, setExpanded] = useState(true);
  const { beginNewWorktree, beginConfigureProject } = useSelection();
  const { data: worktrees = [], isLoading, error } = useWorktrees(project.id);
  const removeProject = useRemoveProject();

  return (
    <div className="flex flex-col">
      <div className="group flex items-center gap-0.5 py-0.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground"
        >
          <ChevronRight
            className={cn(
              "size-3 transition-transform",
              expanded && "rotate-90",
            )}
          />
          <span className="truncate">{project.name}</span>
          {worktrees.length > 0 && (
            <span className="tabular text-[10px] font-medium text-muted-foreground/60 normal-case">
              {worktrees.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => beginNewWorktree(project.id)}
          aria-label={`New worktree in ${project.name}`}
          title={`New worktree in ${project.name}`}
          className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={`More actions for ${project.name}`}
                className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground aria-expanded:opacity-100"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="end" sideOffset={2}>
            <DropdownMenuItem onClick={() => beginConfigureProject(project.id)}>
              Configure…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => removeProject.mutate(project.id)}
            >
              Remove from Shigoto
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded && (
        <div className="flex flex-col gap-0.5 pl-3">
          {isLoading && (
            <div
              className="space-y-1 px-2 py-1.5"
              aria-label="Loading worktrees"
            >
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
            </div>
          )}
          {error && (
            <div className="px-2 py-1 text-xs text-destructive">
              Failed to list worktrees
            </div>
          )}
          {!isLoading &&
            !error &&
            worktrees.map((worktree) => (
              <WorktreeRow key={worktree.id} worktree={worktree} />
            ))}
        </div>
      )}
    </div>
  );
}
