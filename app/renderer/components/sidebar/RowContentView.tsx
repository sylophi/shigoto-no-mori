// Each sidebar row drawn from its SidebarRow alone, for a picture of
// the sidebar (lab/scenes). The live rows (RowContent) look their state
// up for themselves and act. Here everything a row looks up comes in
// as SidebarRowLookups, and nothing acts.
import { Skeleton } from "@/components/ui/skeleton";
import { assertNever } from "@/lib/utils";
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
import type { SidebarRow } from "./sidebarRow";
import { WorktreeRowView } from "./WorktreeRowView";

// A project's worktrees while their listing loads, and when it failed.
export function WorktreeSkeletonRow() {
  return (
    <div className="space-y-1 px-2 py-1.5" aria-label="Loading worktrees">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-4 w-24" />
    </div>
  );
}

export function WorktreeErrorRow() {
  return (
    <div className="px-2 py-1 text-xs text-muted-foreground">
      Couldn't load worktrees.
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
  forwardTipOf?: (worktree: Worktree, deviceId: string) => string | undefined;
  // The group key of the project the page on screen belongs to.
  currentGroupKey?: string;
  // This machine's name, for a quick create that names its device.
  localDeviceLabel?: string;
}

// One row, drawn at rest: nothing hovered, nothing being arranged, no
// villager living in it.
export function RowContentView({
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
      const iconDevice = row.local ? undefined : row.members[0]?.deviceId;
      return (
        <ProjectRowView
          pickable={!row.expanded && !missing}
          current={row.groupKey === lookups.currentGroupKey}
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
