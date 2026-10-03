// A project's row in the tree, drawn (ProjectRow makes it sortable and
// gives it its actions): the header, the count of worktrees on the
// list, and the `+` and `…`.
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from "react";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";

export function ProjectRowView({
  header,
  actions,
  pickable,
  current,
  branches,
  isHovered,
  arrangeMode,
  sortable,
}: {
  // The name (ProjectHeader or ProjectHeaderView).
  header: ReactNode;
  // The `+` and `…` (ProjectGroupActions or ProjectGroupActionsView),
  // none while arranging.
  actions: ReactNode;
  // One of the list, to go into: not the open project, not arranging,
  // not a missing checkout.
  pickable: boolean;
  // The page on screen belongs to this project.
  current: boolean;
  // On the list, the worktrees the project holds beside its primary
  // checkouts.
  branches: number | undefined;
  // The cursor is somewhere in the project's region of the sidebar.
  isHovered: boolean;
  arrangeMode: boolean;
  // The drag's hold on the row while arranging (useSortable).
  sortable?: {
    ref: Ref<HTMLDivElement>;
    style: CSSProperties;
    attributes: HTMLAttributes<HTMLDivElement> | undefined;
    isDragging: boolean;
  };
}) {
  return (
    <div
      ref={sortable?.ref}
      style={sortable?.style}
      className={cn("relative rounded-md", sortable?.isDragging && "opacity-0")}
      {...sortable?.attributes}
    >
      <div
        // A row of the list is picked as one pill, though the click
        // target is the name's button beside the row's own actions:
        // the slot has doubutsu stripe the row rather than a band of it.
        data-slot={pickable ? "sidebar-project-row" : undefined}
        className={cn(
          "group/project relative flex items-center gap-0.5 rounded-md py-0.5 transition-colors",
          // It fills like the worktree rows it leads to: under the
          // pointer, and for the project the page on screen belongs
          // to, which is where the list was left from.
          pickable && (current ? "bg-accent" : "hover:bg-accent/60"),
        )}
      >
        {header}
        {!arrangeMode &&
          branches !== undefined &&
          branches > 0 && (
            // On the list a project says how much work it holds. The number
            // sits where the `+` and `…` come up and gives way to them,
            // so the line has one right edge. A phone shows the actions
            // at rest, so there it takes a place of its own before them.
            <span
              aria-label={pluralize(branches, "worktree")}
              title={pluralize(branches, "worktree")}
              className={cn(
                "pointer-events-none absolute right-2 text-3xs text-muted-foreground tabular-nums transition-opacity phone:static phone:px-1",
                // The actions also come up for an open menu and for
                // keyboard focus, with no hover to go by.
                "group-has-[[data-icon-button]:focus-visible]/project:opacity-0 group-has-[[data-icon-button][aria-expanded=true]]/project:opacity-0",
                isHovered && "opacity-0 phone:opacity-100",
              )}
            >
              {branches}
            </span>
          )}
        {!arrangeMode && actions}
      </div>
    </div>
  );
}
