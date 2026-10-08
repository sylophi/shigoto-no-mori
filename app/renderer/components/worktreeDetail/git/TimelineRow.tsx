import { createContext, use, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Where a row sits on the Git timeline's line: the line runs through
// every node, so the first row draws no segment above its node and the
// last none below. Handed down by Rail, so a row is a plain element.
interface RailPlace {
  first: boolean;
  last: boolean;
}

const RailPlaceContext = createContext<RailPlace>({ first: true, last: true });

// Rows drawn as one line, each told where on it it sits.
export function Rail({
  rows,
}: {
  rows: readonly { key: string; row: ReactNode }[];
}) {
  return rows.map(({ key, row }, i) => (
    <RailPlaceContext
      key={key}
      value={{ first: i === 0, last: i === rows.length - 1 }}
    >
      {row}
    </RailPlaceContext>
  ));
}

// One row of the timeline: a node on the rail, then the row's content.
// The rail is drawn as a segment above the node and one below it, so
// the page's wallpaper shows around the node rather than a patch. The
// node sits on the content's first line (rows pad by py-1.5 and lead
// with a text-sm line), so a two-line row keeps its mark beside the
// heading. `faded` is history past the branch.
export function TimelineRow({
  node,
  faded = false,
  className,
  children,
}: {
  node: ReactNode;
  faded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const place = use(RailPlaceContext);
  const line = faded ? "bg-muted-foreground/20" : "bg-muted-foreground/35";
  return (
    // A slimmer rail in a column (the Git page's sidebar), where every
    // pixel of it comes off the subjects.
    <div
      data-slot="git-timeline-row"
      className={cn(
        "grid grid-cols-[1.25rem_1fr] gap-x-2 @max-md/timeline:grid-cols-[0.875rem_1fr] @max-md/timeline:gap-x-1.5",
        className,
      )}
    >
      <div aria-hidden className="flex flex-col items-center">
        <span className={cn("mb-0.5 h-1.5 w-px", !place.first && line)} />
        <span className="flex h-4 items-center justify-center">{node}</span>
        <span className={cn("mt-0.5 w-px flex-1", !place.last && line)} />
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// The node for a commit: a dot, in the accent while it exists only
// here, muted once a remote has it.
export function CommitDot({ local }: { local: boolean }) {
  return (
    <span
      className={cn(
        "size-2.5 rounded-full",
        local ? "bg-emerald-500" : "bg-muted-foreground/45",
      )}
    />
  );
}

// Which view the timeline is drawn in. On the worktree page it is the
// overview of the worktree's git, and a row opens the Git page on
// itself. On the Git page it is the History tab: the branch's commits
// alone (the changes and stashes have the Changes tab), the selected
// one marked, and a pick replaces the page's entry, so Back still
// leaves the page.
export interface TimelineView {
  onGitPage: boolean;
  // `branch` or `commit:<hash>`.
  selected: string | null;
}

const TimelineViewContext = createContext<TimelineView>({
  onGitPage: false,
  selected: null,
});

export const TimelineViewProvider = TimelineViewContext;

export function useTimelineView(): TimelineView {
  return use(TimelineViewContext);
}

// Whether a row is the Git page's selection.
export function useRowSelection(key: string): boolean {
  return useTimelineView().selected === key;
}
