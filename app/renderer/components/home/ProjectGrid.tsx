// The home page: the sidebar's list of projects laid out as tiles, for
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
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { AlertTriangle, GitPullRequest } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { PAGE_BODY } from "@/components/shared/PageShell";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { SectionHeading } from "@/components/ui/section-heading";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useRepoDescription } from "@/hooks/projects/useRepoDescription";
import { useNow } from "@/hooks/ui/useNow";
import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { pluralize } from "@/lib/pluralize";
import { readWorktreeVisits } from "@/lib/recentWorktrees";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { DeviceBadgeCluster } from "@/components/sidebar/DeviceBadge";
import { useForestSources } from "@/components/sidebar/forestSources";
import {
  ProjectGroupActions,
  useGroupMembers,
  useIconMember,
} from "@/components/sidebar/ProjectGroupActions";
import { useLocateProject } from "@/components/sidebar/LocateProjectPicker";
import { StatusPill } from "@/components/sidebar/StatusPill";
import {
  buildGrid,
  type GroupWork,
  type ProjectTileRow,
  type Section,
} from "./gridModel";

export function ProjectGrid() {
  const sources = useForestSources({ warm: true });
  // Read once per visit, like the palette's: the page is up between
  // visits, never during one.
  const [visits] = useState(readWorktreeVisits);
  const { sections, work } = buildGrid({
    ...sources.local,
    order: sources.order,
    hiddenPrefixes: sources.hiddenPrefixes,
    allowAgentWorking: sources.allowAgentWorking,
    byOwner: sources.groupByOwner,
    remote: sources.shownRemote,
    mirrors: sources.mirrors,
    deviceBadges: sources.deviceBadges,
    visits,
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Projects" watermark="森" />
      <div className={PAGE_BODY}>
        {sections.length > 0 ? (
          <Grid sections={sections} work={work} />
        ) : sources.loading ? null : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {sources.activeFilter
              ? `No projects on ${sources.activeFilter.label}.`
              : "No projects yet."}
          </p>
        )}
      </div>
    </div>
  );
}

function Grid({
  sections,
  work,
}: {
  sections: readonly Section[];
  work: ReadonlyMap<string, GroupWork>;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useColumnCount(gridRef);
  const { toPageOn } = useWorktreeNav();
  const { openCreateForm } = useQuickCreateWorktree();
  // The worktree the tile names, or with none anywhere yet, the place
  // to make one: the palette's ↩ on a project.
  const open = (row: ProjectTileRow, lead: GroupWork["lead"]) => {
    if (lead) {
      toPageOn(lead.device?.deviceId, "detail", {
        projectId: lead.worktree.projectId,
        worktreeId: lead.worktree.id,
      });
    } else {
      openCreateForm(
        row.project.id,
        row.local ? undefined : row.members[0]?.deviceId,
      );
    }
  };
  return (
    // Arrows move between the tiles, across the sections, as on a
    // launcher.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the keys only move focus between the tiles, which are the controls
    <div
      ref={gridRef}
      onKeyDown={(event) => moveFocus(event, gridRef.current)}
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
            gridColumn: `span ${Math.min(section.rows.length, columns)}`,
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
            {section.rows.map((row) => {
              const tileWork = work.get(row.groupKey);
              return (
                <ProjectTile
                  key={row.key}
                  row={row}
                  work={tileWork}
                  onOpen={() => open(row, tileWork?.lead)}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// The narrowest a tile gets, in spacing steps (w-60), so it grows with
// the phone layout's scale as the rest of the page does.
const TILE_MIN_STEPS = 60;
// The grid's gap-x-3, which is how the hook reads a step in pixels.
const GAP_STEPS = 3;

// How many tiles fit across the grid, re-read as the pane resizes.
function useColumnCount(ref: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const gap = parseFloat(getComputedStyle(el).columnGap);
      const tile = (gap / GAP_STEPS) * TILE_MIN_STEPS;
      const fit = Math.floor((el.clientWidth + gap) / (tile + gap));
      // At least one, whatever the gap reads as.
      setColumns(Number.isFinite(fit) ? Math.max(1, fit) : 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return columns;
}

function ProjectTile({
  row,
  work,
  onOpen,
}: {
  row: ProjectTileRow;
  work: GroupWork | undefined;
  onOpen: () => void;
}) {
  const { project, local, devices, members, branches } = row;
  const [hovered, setHovered] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const group = useGroupMembers(members, local ? project : undefined);
  // The member the icon and the About are read from.
  const iconMember = useIconMember(group, local);
  const sourceId = iconMember?.project.id ?? project.id;
  const sourceDevice = iconMember?.deviceId;
  const missing = project.pathExists === false;
  const description = useRepoDescription(sourceId, sourceDevice, !missing);
  const descriptionId = useId();
  // A missing project's tile locates it, as its sidebar row does.
  const { relocating, onLocate, picker } = useLocateProject(
    group,
    project,
    missing,
  );
  const lead = work?.lead;
  // This machine's listing is still loading (or failed): the list row
  // has no count then either. Not a project with nothing in it, so the
  // tile neither opens a worktree nor offers to make one until it knows.
  const unlisted = !missing && lead === undefined && branches === undefined;
  const worktrees =
    branches !== undefined && branches > 0
      ? pluralize(branches, "worktree")
      : null;
  const active = work !== undefined && work.lastActivity > 0;
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- hover only reveals the actions, which are buttons of their own
    <div
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
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
            <ProjectIcon
              projectId={sourceId}
              name={project.name}
              deviceId={sourceDevice}
              className="size-8"
            />
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
              <DeviceBadgeCluster devices={devices} />
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
            <StatusPill
              icon={GitPullRequest}
              tone="emerald"
              tip={pluralize(work.openPullRequests, "open pull request")}
              aria-label={pluralize(work.openPullRequests, "open pull request")}
            >
              {work.openPullRequests}
            </StatusPill>
          )}
        </span>
      </button>
      {/* A missing project keeps them too, as its sidebar row does:
          Remove is how it goes. */}
      <div className="absolute top-2 right-2 flex items-center gap-0.5">
        <ProjectGroupActions
          name={project.name}
          identity={project.identity}
          members={group}
          isHovered={hovered}
          triggerRef={triggerRef}
          onLocate={onLocate}
        />
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
