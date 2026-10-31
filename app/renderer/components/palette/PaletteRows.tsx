import type {
  PaletteEntry,
  PaletteProject,
  PaletteRow,
} from "@shigomori/ui/views/palette/paletteEntries.ts";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { useShowDeviceBadges } from "@/hooks/config/useSidebarMarks";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { SHELF_LABELS } from "@shigomori/ui/views/sidebar/sidebarRow.ts";
import {
  CreateRowView,
  PageRowView,
  ProjectRowView,
  WorktreeRowView,
} from "@shigomori/ui/views/palette/PaletteRowsView.tsx";

export function PaletteRowContent({
  row,
  query,
  now,
  creating,
}: {
  row: PaletteRow;
  query: string;
  now: number;
  creating: boolean;
}) {
  switch (row.kind) {
    case "worktree":
      return <WorktreeRow entry={row.entry} query={query} now={now} />;
    case "project":
      return <ProjectRow item={row.item} query={query} />;
    case "page":
      return <PageRowView page={row.page} query={query} />;
    case "create":
      return <CreateRow row={row} creating={creating} />;
  }
}

// A worktree's row, with its status read off the sidebar's settings.
function WorktreeRow({
  entry,
  query,
  now,
}: {
  entry: PaletteEntry;
  query: string;
  now: number;
}) {
  const { worktree, project, device } = entry;
  const showBadge = useShowDeviceBadges();
  return (
    <WorktreeRowView
      entry={entry}
      query={query}
      now={now}
      status={entry.shelf ? SHELF_LABELS[entry.shelf].toLowerCase() : undefined}
      showBadge={showBadge}
      icon={
        <ProjectIcon
          projectId={worktree.projectId}
          name={project.name}
          deviceId={device?.deviceId}
        />
      }
      kindIcon={<WorktreeKindIcon worktree={worktree} />}
    />
  );
}

function ProjectRow({ item, query }: { item: PaletteProject; query: string }) {
  const { project, device } = item;
  return (
    <ProjectRowView
      item={item}
      query={query}
      icon={
        <ProjectIcon
          projectId={project.id}
          name={project.name}
          deviceId={device?.deviceId}
        />
      }
    />
  );
}

function CreateRow({
  row,
  creating,
}: {
  row: Extract<PaletteRow, { kind: "create" }>;
  creating: boolean;
}) {
  const [target] = row.targets;
  // What quickCreate forks from.
  const { data: base } = useDefaultBranch(target.id);
  return (
    <CreateRowView
      branch={row.branch}
      projectName={target.name}
      base={base}
      creating={creating}
    />
  );
}
