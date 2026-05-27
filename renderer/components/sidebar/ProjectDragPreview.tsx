import type { Project } from "@shared/schemas";

interface ProjectDragPreviewProps {
  project: Project;
}

// Matches the arrange-mode ProjectHeader layout so the preview lines
// up exactly with the row the cursor grabbed.
export function ProjectDragPreview({ project }: ProjectDragPreviewProps) {
  return (
    <div className="py-0.5">
      <div className="flex cursor-grabbing items-center rounded-md bg-card px-2 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase shadow-md outline -outline-offset-1 outline-foreground/25">
        <span className="min-w-0 truncate">{project.name}</span>
      </div>
    </div>
  );
}
