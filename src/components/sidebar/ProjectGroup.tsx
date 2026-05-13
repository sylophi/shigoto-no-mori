import { useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSelection } from "@/hooks/useSelection";
import type { Project } from "@shared/types";
import { WorktreeRow } from "./WorktreeRow";

interface ProjectGroupProps {
  project: Project;
}

export function ProjectGroup({ project }: ProjectGroupProps) {
  const [expanded, setExpanded] = useState(true);
  const { beginNewWorktree } = useSelection();

  return (
    <div className="flex flex-col">
      <div className="group flex items-center gap-1 py-1">
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
          <span className="tabular text-[10px] font-medium text-muted-foreground/70">
            {project.worktrees.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => beginNewWorktree(project.id)}
          className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground"
          aria-label={`New worktree in ${project.name}`}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {expanded && (
        <div className="flex flex-col gap-0.5 pl-3">
          {project.worktrees.map((worktree) => (
            <WorktreeRow key={worktree.id} worktree={worktree} />
          ))}
        </div>
      )}
    </div>
  );
}
