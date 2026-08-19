import { Folder } from "lucide-react";
import { ProjectIcon } from "@/components/sidebar/ProjectIcon";
import { cn } from "@/lib/utils";
import type { TidyEntry } from "./tidyModel";
import { TidyVerdictBadge } from "./TidyVerdictBadge";

interface TidyEntryTitleProps {
  entry: TidyEntry;
  // Off inside a project group, where the heading already says it. The
  // icon goes with the name, so both are behind the same flag.
  showProject: boolean;
  className?: string;
  children?: React.ReactNode;
}

// What names one worktree: its project's icon, "project / worktree", and
// the verdict. The confirm dialog exists to restate the row it is about
// to act on, so the two read from one component rather than two copies
// that can drift.
export function TidyEntryTitle({
  entry,
  showProject,
  className,
  children,
}: TidyEntryTitleProps) {
  const { project, worktree, verdict } = entry;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {/* Fallback icon rather than nothing, for the same reason the
            inbox uses one: this list mixes projects, so a missing icon
            would ragged-edge every row around it. */}
        {showProject && (
          <ProjectIcon
            projectId={project.id}
            className="size-3"
            fallback={Folder}
          />
        )}
        <span
          className={cn("min-w-0 truncate font-medium select-text", className)}
        >
          {showProject && (
            <>
              <span className="font-normal text-muted-foreground">
                {project.name}
              </span>
              <span aria-hidden className="px-1 text-muted-foreground/60">
                /
              </span>
            </>
          )}
          {worktree.name}
        </span>
      </div>
      <TidyVerdictBadge kind={verdict.kind} />
      {children}
    </div>
  );
}
