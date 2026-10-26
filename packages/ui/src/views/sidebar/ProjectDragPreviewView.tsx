import type { Project } from "@shigomori/contracts/schemas";
import { cn } from "../../lib/utils.ts";

interface ProjectDragPreviewProps {
  project: Project;
  // Filing into a folder: just the name, as wide as it.
  chip?: boolean;
}

// Matches the arrange-mode ProjectHeader layout so the preview lines
// up exactly with the row the cursor grabbed.
export function ProjectDragPreviewView({
  project,
  chip = false,
}: ProjectDragPreviewProps) {
  return (
    <div className={cn("py-0.5", chip && "w-fit max-w-full")}>
      <div className="flex cursor-grabbing items-center rounded-md bg-card px-2 py-1 text-xs font-medium text-muted-foreground shadow-md outline -outline-offset-1 outline-foreground/25">
        <span className="min-w-0 truncate">{project.name}</span>
      </div>
    </div>
  );
}
