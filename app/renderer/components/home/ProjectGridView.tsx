// The home page, drawn (ProjectGrid.tsx binds it): the sidebar's list of projects laid out as tiles, for
// the main pane to show while nothing is open.
// The same projects in the same order, narrowed by the same device
// filter and split by owner the same way (forestSources.ts and the
// tree's own builder), so the grid and the list beside it never
// disagree about what there is.
//
// Where the list's row only goes into the project, a tile goes into its
// work: it opens the worktree visited last (the ⌘K palette's recency),
// and the sidebar follows the page into the project. Its line under the
// name is the repo's GitHub About, and the one below says how much is
// going on there.
import {
  useId,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { AlertTriangle, GitPullRequest } from "lucide-react";
import { PageHeaderView } from "@shigomori/ui/views/shared/PageHeaderView.tsx";
import { PAGE_BODY } from "@shigomori/ui/views/shared/PageShellView.tsx";
import { PinnedMarkView } from "@shigomori/ui/views/shared/PinnedMarkView.tsx";
import { SectionHeading } from "@shigomori/ui/primitives/section-heading.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { useNow } from "@shigomori/ui/hooks/useNow.ts";
import { pluralize } from "@/lib/pluralize";
import { formatRelativeTime } from "@shigomori/ui/lib/relativeTime.ts";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { DeviceBadgeClusterView } from "@/components/sidebar/DeviceBadgeView";
import { StatusPillView } from "@/components/sidebar/StatusPillView";
import type {
  ProjectListRow,
  ProjectSection,
} from "@/components/sidebar/projectListSections";
import type { GroupWork } from "./gridModel";

export function ProjectGridView({
  grid,
  empty,
}: {
  // The tiles (ProjectGridLayoutView), null with no projects to show.
  grid: ReactNode | null;
  // What the page says with none, null while they load.
  empty: string | null;
}) {
  return (
    <div className="flex h-full flex-col">
      <PageHeaderView title="Projects" watermark="森" />
      <div className={PAGE_BODY}>
        {grid ??
          (empty !== null && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {empty}
            </p>
          ))}
      </div>
    </div>
  );
}

export function ProjectGridLayoutView({
  sections,
  columns,
  gridRef,
  tiles,
}: {
  sections: readonly ProjectSection[];
  // As many as fit across the pane (measured by the container).
  columns: number;
  gridRef?: Ref<HTMLDivElement>;
  // Each row's tile (ProjectTile), by row key.
  tiles: ReadonlyMap<string, ReactNode>;
}) {
  return (
    // Arrows move between the tiles, across the sections, as on a
    // launcher.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the keys only move focus between the tiles, which are the controls
    <div
      ref={gridRef}
      onKeyDown={(event) => moveFocus(event, event.currentTarget)}
      // As many columns as fit, stretched to fill the line, and every
      // section on them, so the tiles line up from one owner to the
      // next. The owners flow on together, so a run of owners with a
      // project or two each shares a line rather than leaving most of
      // one empty.
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      className="grid gap-x-3 gap-y-6"
    >
      {sections.map((section) => (
        <section
          key={section.key}
          style={{
            // An unnamed section (the pinned projects, or the rest of
            // a list that isn't split) has no heading to stand level
            // with, so it takes lines of its own.
            gridColumn:
              section.label === null
                ? "1 / -1"
                : `span ${Math.min(section.rows.length, columns)}`,
          }}
          className="grid grid-cols-subgrid content-start gap-y-2"
        >
          {section.label !== null && (
            // On one line however few columns the owner spans, so its
            // tiles stay level with the tiles beside them.
            <SimpleTooltip whenTruncated tip={section.label}>
              <SectionHeading className="col-span-full truncate">
                {section.label}
              </SectionHeading>
            </SimpleTooltip>
          )}
          <div className="col-span-full grid grid-cols-subgrid gap-y-3">
            {section.rows.map((row) => tiles.get(row.key))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function ProjectTileView({
  row,
  work,
  showBadges,
  description,
  missing,
  relocating,
  onLocate,
  unlisted,
  onOpen,
  onHover,
  triggerRef,
  icon,
  actions,
  picker,
}: {
  row: ProjectListRow;
  work: GroupWork | undefined;
  showBadges: boolean;
  // The repo's GitHub About.
  description: string | null | undefined;
  // Missing on disk: the tile locates it, as its sidebar row does.
  missing: boolean;
  relocating: boolean;
  onLocate: (() => void) | undefined;
  // This machine's listing is still loading (or failed): the tile
  // neither opens a worktree nor offers to make one until it knows.
  unlisted: boolean;
  onOpen: () => void;
  // Hover reveals the actions.
  onHover: (hovered: boolean) => void;
  // The actions' menu trigger, which a right-click pops.
  triggerRef: RefObject<HTMLButtonElement | null>;
  // The project's icon (ProjectIcon).
  icon: ReactNode;
  // The `+` and `…` over the corner (ProjectGroupActions).
  actions: ReactNode;
  // The locate picker, while it is open.
  picker: ReactNode;
}) {
  const { project, devices, branches, pinned } = row;
  const descriptionId = useId();
  const lead = work?.lead;
  const worktrees =
    branches !== undefined && branches > 0
      ? pluralize(branches, "worktree")
      : null;
  const active = work !== undefined && work.lastActivity > 0;
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- hover only reveals the actions, which are buttons of their own
    <div
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      // Right-click pops the actions' menu, as on the sidebar's row.
      onContextMenu={(event) => {
        if (triggerRef.current === null) return;
        event.preventDefault();
        triggerRef.current.click();
      }}
      className={cn(
        "relative rounded-lg border border-border bg-card transition-colors",
        (!missing || onLocate !== undefined) &&
          "hover:bg-accent/60 has-[[aria-expanded=true]]:bg-accent/60",
      )}
    >
      <button
        type="button"
        data-project-tile
        disabled={missing ? onLocate === undefined : unlisted}
        onClick={missing ? onLocate : onOpen}
        aria-label={
          missing
            ? `${project.name}, locate`
            : lead
              ? `${project.name}, open ${lead.worktree.branch}`
              : `${project.name}, new worktree`
        }
        aria-describedby={!missing && description ? descriptionId : undefined}
        className="flex w-full flex-col gap-2.5 rounded-lg p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {missing ? (
            <AlertTriangle className="size-8 shrink-0 p-1.5 text-destructive/70" />
          ) : (
            icon
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* Clear of the `+` and `…` that come up over the corner,
                which sit above the line under it. */}
            <span className="flex min-w-0 items-center gap-1.5 pr-12">
              <SimpleTooltip whenTruncated tip={project.name}>
                <span
                  className={cn(
                    "min-w-0 truncate text-sm font-medium",
                    missing && "text-muted-foreground line-through",
                  )}
                >
                  {project.name}
                </span>
              </SimpleTooltip>
              {pinned && <PinnedMarkView />}
              {showBadges && <DeviceBadgeClusterView devices={devices} />}
            </span>
            {/* Two lines tall even when shorter or empty, so a repo
                with a short About (or none) lines its stats up with
                the tiles beside it, in other owners' sections too. */}
            <SimpleTooltip whenTruncated tip={missing ? null : description}>
              <span
                id={descriptionId}
                className="line-clamp-2 min-h-[2lh] min-w-0 text-2xs text-muted-foreground"
              >
                {missing
                  ? relocating
                    ? "Locating…"
                    : "Missing on disk"
                  : description}
              </span>
            </SimpleTooltip>
          </span>
        </span>
        <span className="flex h-4 items-center gap-2 text-3xs text-muted-foreground tabular-nums">
          {(worktrees !== null || active) && (
            <span>
              {worktrees}
              {worktrees !== null && active && ", active "}
              {worktrees === null && active && "Active "}
              {active && <Ago at={work.lastActivity} />}
            </span>
          )}
          {work !== undefined && work.openPullRequests > 0 && (
            <StatusPillView
              icon={GitPullRequest}
              tone="emerald"
              tip={pluralize(work.openPullRequests, "open pull request")}
              aria-label={pluralize(work.openPullRequests, "open pull request")}
            >
              {work.openPullRequests}
            </StatusPillView>
          )}
        </span>
      </button>
      {/* A missing project keeps them too, as its sidebar row does:
          Remove is how it goes. */}
      <div className="absolute top-2 right-2 flex items-center gap-0.5">
        {actions}
      </div>
      {picker}
    </div>
  );
}

// "3h ago", on a clock of its own, so the tick re-renders this alone.
function Ago({ at }: { at: number }) {
  const now = useNow();
  return <>{formatRelativeTime(at, now)}</>;
}

// Arrow keys between the tiles: left and right along the reading
// order, up and down to the nearest tile in the next line of tiles,
// whichever section it is in, read off the laid-out grid so it holds
// at any width.
function moveFocus(event: KeyboardEvent, root: HTMLElement | null) {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 0, ArrowDown: 0 }[
    event.key
  ];
  if (!root || step === undefined) return;
  const tiles = [
    ...root.querySelectorAll<HTMLButtonElement>(
      "button[data-project-tile]:not(:disabled)",
    ),
  ];
  const from = tiles.indexOf(document.activeElement as HTMLButtonElement);
  const current = tiles[from];
  if (!current) return;
  event.preventDefault();
  if (step !== 0) {
    tiles[from + step]?.focus();
    return;
  }
  const boxes = tiles.map((tile) => ({
    tile,
    box: tile.getBoundingClientRect(),
  }));
  const here = current.getBoundingClientRect();
  const down = event.key === "ArrowDown";
  // The next line is the nearest by height, and in it the tile whose
  // left edge is nearest.
  const target = boxes
    .filter(({ box }) =>
      down ? box.top > here.bottom - 1 : box.bottom < here.top + 1,
    )
    .toSorted(
      (a, b) =>
        Math.abs(a.box.top - here.top) - Math.abs(b.box.top - here.top) ||
        Math.abs(a.box.left - here.left) - Math.abs(b.box.left - here.left),
    )[0];
  target?.tile.focus();
}
