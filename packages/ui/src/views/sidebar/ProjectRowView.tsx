// A project's row in the sidebar (ProjectRow binds it): its header,
// how many worktrees it holds on the list, and its actions.
import type { ReactNode } from "react";
import type { DraggableAttributes } from "@dnd-kit/core";
import { pluralize } from "../../lib/pluralize.ts";
import { cn } from "../../lib/utils.ts";

export function ProjectRowView({
  sortable,
  arrangeMode,
  pickable,
  current,
  folded,
  branches,
  isHovered,
  header,
  actions,
  picker,
}: {
  // The row's place in the arranging drag (useSortable).
  sortable: {
    setNodeRef?: (node: HTMLElement | null) => void;
    style?: React.CSSProperties;
    attributes?: DraggableAttributes;
    isDragging?: boolean;
  };
  arrangeMode: boolean;
  // One of the list, to go into.
  pickable: boolean;
  // The page on screen belongs to this project.
  current: boolean;
  // On the inline list, whether the project is folded to the row.
  folded: boolean | undefined;
  // On the list, the worktrees the project holds beside its primaries.
  branches: number | undefined;
  // The cursor is anywhere in this project's region in the sidebar.
  isHovered: boolean;
  // The header (ProjectHeaderView), its `+` and `…`
  // (ProjectGroupActions), and the locate picker while it is open.
  header: ReactNode;
  actions?: ReactNode;
  picker?: ReactNode;
}) {
  return (
    <div
      ref={sortable.setNodeRef}
      style={sortable.style}
      className={cn("relative rounded-md", sortable.isDragging && "opacity-0")}
      // The sortable's marks belong to arranging alone. Outside it the
      // sortable is off, and its aria-disabled would put the
      // not-allowed cursor (index.css) on a row that is only a title,
      // and a tab stop on a wrapper with nothing to do.
      {...(arrangeMode ? sortable.attributes : undefined)}
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
          // to, which is where the list was left from. Unfolded, the
          // page's own row shows that.
          pickable &&
            (current && folded !== false ? "bg-accent" : "hover:bg-accent/60"),
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
      {picker}
    </div>
  );
}
