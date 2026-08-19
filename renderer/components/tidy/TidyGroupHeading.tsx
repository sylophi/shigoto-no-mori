import { Folder } from "lucide-react";
import type { Project } from "@shared/schemas";
import { ProjectIcon } from "@/components/sidebar/ProjectIcon";
import { SectionHeading } from "@/components/ui/section-heading";
import { formatBytes } from "@/lib/formatBytes";

interface TidyGroupHeadingProps {
  project: Project;
  count: number;
  // Measured bytes across the group. Climbs as the walks land, same as
  // the headline figure.
  bytes: number;
}

// Label above one project's block of rows in the "Project" sort. Carries
// the group's total so a project can be dismissed as not worth opening
// without reading every row under it.
export function TidyGroupHeading({
  project,
  count,
  bytes,
}: TidyGroupHeadingProps) {
  return (
    <div className="flex items-center justify-between gap-3 px-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <ProjectIcon
          projectId={project.id}
          className="size-3"
          fallback={Folder}
        />
        <SectionHeading className="truncate">{project.name}</SectionHeading>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {count} {count === 1 ? "worktree" : "worktrees"} · {formatBytes(bytes)}
      </span>
    </div>
  );
}
