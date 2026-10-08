import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { cn } from "@/lib/utils";
import type { TidyEntry } from "./tidyModel";
import { TidyVerdictBadge } from "./TidyVerdictBadge";
import { SimpleTooltip } from "@/components/ui/tooltip";

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
    <div className="flex min-w-0 items-center gap-2 phone:flex-wrap phone:gap-y-1">
      <div className="flex min-w-0 items-center gap-1.5">
        {showProject && (
          <ProjectIcon
            projectId={project.id}
            name={project.name}
            className="size-3"
          />
        )}
        <SimpleTooltip
          whenTruncated
          tip={
            showProject ? `${project.name} / ${worktree.name}` : worktree.name
          }
        >
          <span
            className={cn(
              "min-w-0 truncate font-medium select-text",
              className,
            )}
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
        </SimpleTooltip>
      </div>
      <TidyVerdictBadge kind={verdict.kind} />
      {children}
    </div>
  );
}
