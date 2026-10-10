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
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { useRepoDescription } from "@/hooks/projects/useRepoDescription";
import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { readWorktreeVisits } from "@/lib/recentWorktrees";
import { useShowDeviceBadges } from "@/hooks/config/useSidebarMarks";
import { useForestSources } from "@/components/sidebar/forestSources";
import {
  ProjectGroupActions,
  useGroupMembers,
  useIconMember,
} from "@/components/sidebar/ProjectGroupActions";
import { useLocateProject } from "@/components/sidebar/LocateProjectPicker";
import type { ProjectSection } from "@shigomori/ui/views/sidebar/sidebarRow.ts";
import type { ProjectListRow } from "@shigomori/ui/views/sidebar/sidebarRow.ts";
import { buildGrid } from "./gridModel";
import type { GroupWork } from "@shigomori/ui/views/home/ProjectGridView.tsx";
import {
  ProjectGridLayoutView,
  ProjectGridView,
  ProjectTileView,
} from "@shigomori/ui/views/home/ProjectGridView.tsx";

export function ProjectGrid() {
  const sources = useForestSources();
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
    <ProjectGridView
      grid={
        sections.length > 0 ? <Grid sections={sections} work={work} /> : null
      }
      empty={
        sources.loading
          ? null
          : sources.activeFilter
            ? `No projects on ${sources.activeFilter.label}.`
            : "No projects yet."
      }
    />
  );
}

function Grid({
  sections,
  work,
}: {
  sections: readonly ProjectSection[];
  work: ReadonlyMap<string, GroupWork>;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useColumnCount(gridRef);
  const { toPageOn } = useWorktreeNav();
  const { openCreateForm } = useQuickCreateWorktree();
  // The worktree the tile names, or with none anywhere yet, the place
  // to make one: the palette's ↩ on a project.
  const open = (row: ProjectListRow, lead: GroupWork["lead"]) => {
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
    <ProjectGridLayoutView
      sections={sections}
      columns={columns}
      gridRef={gridRef}
      tiles={
        new Map(
          sections.flatMap((section) =>
            section.rows.map((row) => {
              const tileWork = work.get(row.groupKey);
              return [
                row.key,
                <ProjectTile
                  key={row.key}
                  row={row}
                  work={tileWork}
                  onOpen={() => open(row, tileWork?.lead)}
                />,
              ] as const;
            }),
          ),
        )
      }
    />
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
  row: ProjectListRow;
  work: GroupWork | undefined;
  onOpen: () => void;
}) {
  const showBadges = useShowDeviceBadges();
  const { project, local, members, branches, pinned } = row;
  const [hovered, setHovered] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const group = useGroupMembers(members, local ? project : undefined);
  // The member the icon and the About are read from.
  const iconMember = useIconMember(group, local);
  const sourceId = iconMember?.project.id ?? project.id;
  const sourceDevice = iconMember?.deviceId;
  const missing = project.pathExists === false;
  const description = useRepoDescription(sourceId, sourceDevice, !missing);
  // A missing project's tile locates it, as its sidebar row does.
  const { relocating, onLocate, picker } = useLocateProject(
    group,
    project,
    missing,
  );
  const lead = work?.lead;
  return (
    <ProjectTileView
      row={row}
      work={work}
      showBadges={showBadges}
      description={description}
      missing={missing}
      relocating={relocating}
      onLocate={onLocate}
      // This machine's listing is still loading (or failed): the list
      // row has no count then either.
      unlisted={!missing && lead === undefined && branches === undefined}
      onOpen={onOpen}
      onHover={setHovered}
      triggerRef={triggerRef}
      icon={
        <ProjectIcon
          projectId={sourceId}
          name={project.name}
          deviceId={sourceDevice}
          className="size-8"
        />
      }
      // A missing project keeps them too, as its sidebar row does:
      // Remove is how it goes.
      actions={
        <ProjectGroupActions
          name={project.name}
          identity={project.identity}
          groupKey={row.groupKey}
          pinned={pinned}
          members={group}
          isHovered={hovered}
          triggerRef={triggerRef}
          onLocate={onLocate}
        />
      }
      picker={picker}
    />
  );
}
