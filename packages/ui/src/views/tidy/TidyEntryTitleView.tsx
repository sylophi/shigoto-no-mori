import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import type { TidyEntry } from "./tidyModel.ts";
import { TidyVerdictBadgeView } from "./TidyVerdictBadgeView.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";

interface TidyEntryTitleProps {
  entry: TidyEntry;
  // Off inside a project group, where the heading already says it. The
  // icon goes with the name, so both are behind the same flag.
  showProject: boolean;
  // Its project's icon (ProjectIcon).
  icon: ReactNode;
  className?: string;
  children?: ReactNode;
}

// What names one worktree: its project's icon, "project / worktree", and
// the verdict. The confirm dialog exists to restate the row it is about
// to act on, so the two read from one component rather than two copies
// that can drift.
export function TidyEntryTitleView({
  entry,
  showProject,
  icon,
  className,
  children,
}: TidyEntryTitleProps) {
  const { project, worktree, verdict } = entry;
  return (
    <div className="flex min-w-0 items-center gap-2 phone:flex-wrap phone:gap-y-1">
      <div className="flex min-w-0 items-center gap-1.5">
        {showProject && icon}
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
      <TidyVerdictBadgeView kind={verdict.kind} />
      {children}
    </div>
  );
}
