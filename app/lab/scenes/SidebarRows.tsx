// The sidebar's rows drawn from their SidebarRow alone, as a plain
// stacked list, for LabSidebar. The live list (SidebarList) virtualizes
// the same rows in the same wrappers (VirtualRow), and its rows
// (RowContent) look their state up for themselves and act. Here
// everything a row looks up comes in as SidebarRowLookups, and nothing
// acts.
import { DeviceBadgeClusterView } from "@/components/sidebar/DeviceBadgeView";
import {
  ActivityAgeView,
  InboxRowView,
} from "@/components/sidebar/inbox/InboxRowView";
import { InboxShelfRow } from "@/components/sidebar/inbox/InboxShelfRow";
import {
  ProjectGroupActionsView,
  quickCreateLabel,
} from "@/components/sidebar/ProjectGroupActionsView";
import { ProjectHeaderView } from "@/components/sidebar/ProjectHeaderView";
import { ProjectRowView } from "@/components/sidebar/ProjectRowView";
import type { WorktreeRowLook } from "@/components/sidebar/rowState";
import { ShelvedToggleRow } from "@/components/sidebar/ShelvedToggleRow";
import {
  WorktreeErrorRow,
  WorktreeSkeletonRow,
} from "@/components/sidebar/SidebarFrameView";
import { ROW_LAYOUT, type SidebarRow } from "@/components/sidebar/sidebarRow";
import { WorktreeRowView } from "@/components/sidebar/WorktreeRowView";
import { assertNever, cn } from "@/lib/utils";
import type { Project, Worktree } from "@shared/schemas";

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

export function SidebarRows({
  rows,
  lookups,
}: {
  rows: readonly SidebarRow[];
  lookups: SidebarRowLookups;
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
            <SidebarRowContent row={row} lookups={lookups} />
          </div>
        </div>
      ))}
    </div>
  );
}

// What the rows look up in the app, handed in: the clock, this window's
// marks, each worktree's state and each project's icon.
export interface SidebarRowLookups {
  // The time "14m ago" counts back from.
  now: number;
  // Settings, Appearance: device badges on rows.
  showDeviceBadges: boolean;
  // What a worktree's row shows of its state: whether it is open, what
  // is running in it. `deviceId` is the peer it lives on, undefined for
  // this machine's.
  lookOf: (worktree: Worktree, deviceId: string | undefined) => WorktreeRowLook;
  // A project's logo (ProjectIconView's `src`).
  iconSrcOf: (project: Project, deviceId: string | undefined) => string | null;
  // The ports this machine forwards from a peer's worktree.
  forwardTipOf: (worktree: Worktree, deviceId: string) => string | undefined;
  // The group key of the project the page on screen belongs to.
  currentGroupKey: string | undefined;
  // This machine's name, for a quick create that names its device.
  localDeviceLabel: string | undefined;
}

// One row, drawn at rest: nothing hovered, nothing being arranged, no
// villager living in it.
export function SidebarRowContent({
  row,
  lookups,
}: {
  row: SidebarRow;
  lookups: SidebarRowLookups;
}) {
  const entryOf = (worktree: Worktree, deviceId: string | undefined) => ({
    look: lookups.lookOf(worktree, deviceId),
    resident: null,
    forwardTip:
      deviceId === undefined
        ? undefined
        : lookups.forwardTipOf(worktree, deviceId),
    showDeviceBadges: lookups.showDeviceBadges,
  });
  switch (row.kind) {
    case "project": {
      const missing = row.project.pathExists === false;
      const deviceCount = row.members.length + (row.local ? 1 : 0);
      const creatorLabel = row.local
        ? lookups.localDeviceLabel
        : row.members[0]?.deviceLabel;
      const current = row.groupKey === lookups.currentGroupKey;
      const iconDevice = row.local ? undefined : row.members[0]?.deviceId;
      return (
        <ProjectRowView
          pickable={!row.expanded && !missing}
          current={current}
          branches={row.branches}
          isHovered={false}
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
              showTerrierPaw={false}
              missing={missing}
              expanded={row.expanded}
              current={current}
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
              // The open project's row is the tree's title, and
              // wears its actions at rest.
              isHovered={row.expanded}
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
          age={<ActivityAgeView worktree={row.worktree} now={lookups.now} />}
          pr={row.pr}
          stack={row.stack}
          device={row.device}
          mirror={row.mirror}
          shelf={row.shelf}
          {...entryOf(row.worktree, row.device?.deviceId)}
        />
      );
    case "worktree-skeleton":
      return <WorktreeSkeletonRow />;
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
      return <WorktreeErrorRow />;
    default:
      return assertNever(row);
  }
}
