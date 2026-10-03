// The forest's rows as a plain stacked list, and each row drawn from
// its SidebarRow, for a picture of the sidebar (lab/scenes). The live
// list (SidebarList) virtualizes the same rows in the same wrappers
// (VirtualRow), and its rows (RowContent) look their state up for
// themselves. Here everything a row looks up comes in as
// SidebarRowLookups.
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Resident } from "@/hooks/villagers/useResident";
import { assertNever, cn } from "@/lib/utils";
import type { Project, Worktree } from "@shared/schemas";
import { DeviceBadgeClusterView } from "./DeviceBadgeView";
import { InboxRowView } from "./inbox/InboxRowView";
import { InboxShelfRow } from "./inbox/InboxShelfRow";
import {
  ProjectGroupActionsView,
  quickCreateLabel,
} from "./ProjectGroupActionsView";
import { ProjectHeaderView } from "./ProjectHeaderView";
import { ProjectRowView } from "./ProjectRowView";
import type { WorktreeRowLook } from "./rowState";
import { ShelvedToggleRow } from "./ShelvedToggleRow";
import { ROW_LAYOUT, type SidebarRow } from "./sidebarRow";
import { WorktreeRowView } from "./WorktreeRowView";

// Stacked in order, each in the wrapper a virtual row wears (its slot
// and ROW_LAYOUT), so the rows sit where the live list puts them. A
// column of flex items, so a row's top margin (a shelf's) stays inside
// its wrapper as it does in the live list's absolutely placed ones.
// The virtualizer steps each row down by the whole-pixel height it
// measured the one above at, so a row of fractional height (the
// phone's) overhangs the next by the fraction. Each row sits in a box
// rounded the same way, where the browser can (calc-size), and keeps
// its own height inside it.
const ROW_STEP = { height: "calc-size(auto, round(size, 1px))" };

export function SidebarListView({
  rows,
  renderRow,
}: {
  rows: readonly SidebarRow[];
  renderRow: (row: SidebarRow) => ReactNode;
}) {
  return (
    <div className="relative flex flex-col">
      {rows.map((row, index) => (
        <div key={row.key} className="min-h-0" style={ROW_STEP}>
          <div
            data-index={index}
            data-slot="sidebar-row"
            className={cn("w-full", ROW_LAYOUT[row.kind])}
          >
            {renderRow(row)}
          </div>
        </div>
      ))}
    </div>
  );
}

// A row held still over the scroller (the open project's header), so
// it stays put as the rows scroll. It has no hover to track: the open
// project's title wears its actions at rest. The gap under it keeps
// the rows scrolling up from being cut off flush against the name.
export function PinnedRowView({
  kind,
  children,
}: {
  kind: SidebarRow["kind"];
  children: ReactNode;
}) {
  return (
    <div data-slot="sidebar-row" className={cn(ROW_LAYOUT[kind], "pb-1")}>
      {children}
    </div>
  );
}

// What the rows look up in the app, handed in: the clock, this window's
// marks, each worktree's state and each project's icon.
export interface SidebarRowLookups {
  // The time "14m ago" counts back from.
  now: number;
  // Settings, Appearance: device badges on rows, and the paw on a
  // terrier project's open header.
  showDeviceBadges: boolean;
  markTerrierProjects: boolean;
  // What a worktree's row shows of its state: whether it is open, what
  // is running in it. `deviceId` is the peer it lives on, undefined for
  // this machine's.
  lookOf: (worktree: Worktree, deviceId: string | undefined) => WorktreeRowLook;
  // A project's logo (ProjectIconView's `src`).
  iconSrcOf: (project: Project, deviceId: string | undefined) => string | null;
  // The ports this machine forwards from a peer's worktree.
  forwardTipOf?: (worktree: Worktree, deviceId: string) => string | undefined;
  // The villager who lives in a worktree, with Village life on.
  residentOf?: (worktree: Worktree) => Resident | null;
  // The group key of the project the page on screen belongs to.
  currentGroupKey?: string;
  // This machine's name, for a quick create that names its device.
  localDeviceLabel?: string;
}

// One row, drawn. The rows the tree hovers (a project's header and its
// worktrees) take `hovered`, which brings the header's actions up.
export function RowContentView({
  row,
  lookups,
  hovered = false,
}: {
  row: SidebarRow;
  lookups: SidebarRowLookups;
  hovered?: boolean;
}) {
  const entryOf = (worktree: Worktree, deviceId: string | undefined) => ({
    look: lookups.lookOf(worktree, deviceId),
    resident: lookups.residentOf?.(worktree) ?? null,
    forwardTip:
      deviceId === undefined
        ? undefined
        : lookups.forwardTipOf?.(worktree, deviceId),
    showDeviceBadges: lookups.showDeviceBadges,
  });
  switch (row.kind) {
    case "project": {
      const missing = row.project.pathExists === false;
      const deviceCount = row.members.length + (row.local ? 1 : 0);
      const creatorLabel = row.local
        ? lookups.localDeviceLabel
        : row.members[0]?.deviceLabel;
      const terrier =
        row.expanded &&
        lookups.markTerrierProjects &&
        [row.project, ...row.members.map((m) => m.project)].some(
          (project) => project.source === "terrier",
        );
      const iconDevice = row.local ? undefined : row.members[0]?.deviceId;
      return (
        <ProjectRowView
          pickable={!row.expanded && !missing}
          current={row.groupKey === lookups.currentGroupKey}
          branches={row.branches}
          isHovered={hovered}
          arrangeMode={false}
          header={
            <ProjectHeaderView
              name={row.project.name}
              iconSrc={lookups.iconSrcOf(row.project, iconDevice)}
              badges={
                <DeviceBadgeClusterView
                  devices={row.devices}
                  show={lookups.showDeviceBadges}
                />
              }
              showTerrierPaw={terrier}
              missing={missing}
              expanded={row.expanded}
              current={row.groupKey === lookups.currentGroupKey}
            />
          }
          actions={
            <ProjectGroupActionsView
              name={row.project.name}
              createLabel={
                missing
                  ? undefined
                  : quickCreateLabel(
                      row.project.name,
                      deviceCount > 1 ? creatorLabel : undefined,
                    )
              }
              isHovered={hovered || row.expanded}
            />
          }
        />
      );
    }
    case "worktree":
      return (
        <WorktreeRowView
          worktree={row.worktree}
          mirror={row.mirror}
          pr={row.pr}
          stack={row.stack}
          stackChild={row.stackChild}
          shelf={row.shelf}
          {...entryOf(row.worktree, undefined)}
        />
      );
    case "remote-worktree":
      return (
        <WorktreeRowView
          worktree={row.worktree}
          device={row.device}
          pr={row.pr}
          stack={row.stack}
          stackChild={row.stackChild}
          shelf={row.shelf}
          {...entryOf(row.worktree, row.device.deviceId)}
        />
      );
    case "inbox-worktree":
      return (
        <InboxRowView
          worktree={row.worktree}
          project={row.project}
          projectIconSrc={lookups.iconSrcOf(row.project, row.device?.deviceId)}
          now={lookups.now}
          pr={row.pr}
          stack={row.stack}
          device={row.device}
          mirror={row.mirror}
          shelf={row.shelf}
          {...entryOf(row.worktree, row.device?.deviceId)}
        />
      );
    case "worktree-skeleton":
      return (
        <div className="space-y-1 px-2 py-1.5" aria-label="Loading worktrees">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      );
    case "shelved-toggle":
      return (
        <ShelvedToggleRow
          shelf={row.shelf}
          count={row.count}
          expanded={row.expanded}
        />
      );
    case "inbox-shelf":
      return (
        <InboxShelfRow
          shelf={row.shelf}
          count={row.count}
          expanded={row.expanded}
        />
      );
    case "worktree-error":
      return (
        <div className="px-2 py-1 text-xs text-muted-foreground">
          Couldn't load worktrees.
        </div>
      );
    default:
      return assertNever(row);
  }
}
