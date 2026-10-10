// The sidebar over the fixtures, as Sidebar draws it once settled at
// the fake host's default pose (nothing running, no update waiting):
// the brand header, the device filter, the view's own controls and
// rows, and the footer. The rows are the app's own (buildSidebarRows,
// buildInboxRows) over the fixture forests.
import { buildGrid } from "@/components/home/gridModel";
import type { ReactNode } from "react";
import type { SidebarView } from "@shigomori/contracts/schemas";
import { AddProjectButtonView } from "@/components/sidebar/AddProjectButtonView";
import {
  buildSidebarRows,
  projectGroupKey,
  projectGroupOrder,
} from "@/components/sidebar/buildSidebarRows";
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadgeView";
import { DeviceBadgeClusterView } from "@/components/sidebar/DeviceBadgeView";
import {
  ALL_DEVICES,
  DeviceFilterBarView,
} from "@/components/sidebar/DeviceFilterBarView";
import { FoldHeaderView } from "@/components/sidebar/FoldHeaderView";
import { buildInboxRows } from "@/components/sidebar/inbox/buildInboxRows";
import { InboxRowView } from "@/components/sidebar/inbox/InboxRowView";
import { NewWorktreeButtonView } from "@/components/sidebar/inbox/NewWorktreeButtonView";
import { ProjectActionsView } from "@/components/sidebar/ProjectActionsView";
import { ProjectHeaderView } from "@/components/sidebar/ProjectHeaderView";
import { ProjectRowView } from "@/components/sidebar/ProjectRowView";
import { QuickCreateButtonView } from "@/components/sidebar/QuickCreateButtonView";
import { ShelfRowView } from "@/components/sidebar/ShelfRowView";
import {
  ForestSlotView,
  InboxCreateRowView,
  PinnedRowView,
  SidebarAsideView,
  SidebarEmptyStateView,
  SidebarScrollerView,
  ViewPaneView,
} from "@/components/sidebar/SidebarFrameView";
import { SidebarTakeoverSlotView } from "@/components/sidebar/SidebarTakeoverView";
import {
  SidebarFooterView,
  SidebarNavActionsView,
  SidebarViewToggleView,
} from "@/components/sidebar/SidebarFooterView";
import { SidebarHeaderView } from "@/components/sidebar/SidebarHeaderView";
import {
  SidebarListView,
  VirtualRowView,
  WorktreesErrorView,
  WorktreesLoadingView,
} from "@/components/sidebar/SidebarRowsView";
import type { SidebarRow } from "@/components/sidebar/sidebarRow";
import { SidebarToolbarView } from "@/components/sidebar/SidebarToolbarView";
import { ProjectSortMenuView } from "@/components/sidebar/SidebarToolbarView";
import type { WorktreeEntry } from "@/components/sidebar/useWorktreeEntry";
import { WorktreeRowView } from "@/components/sidebar/WorktreeRowView";
import { ProjectIconView } from "@shigomori/ui/views/shared/ProjectIconView.tsx";
import type { DeviceRosterEntry } from "@/components/shared/DeviceTabs";
import type { SidebarMarks } from "@/hooks/config/useSidebarMarks";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import { deviceStatusView } from "@shigomori/ui/lib/deviceStatus.ts";
import { assertNever } from "@shigomori/ui/lib/utils.ts";
import {
  accountDevices,
  FAKE_APP_VERSION,
  forests,
  LOCAL_DEVICE_ID,
  THINKPAD_ID,
} from "../fake-host/fixtures";
import { unposedPullRequests } from "../fake-host/pullRequestFixtures";
import { projectIconSrc } from "./world";

// Which app draws the forest: the desktop window on Studio Mac, whose
// own projects are local there, or the web shell, a browser to which
// every machine is a peer.
export type SceneShell = "desktop" | "web";

const noop = () => {};

// What a settled sidebar marks with the default settings.
const MARKS: SidebarMarks = {
  terrier: true,
  deviceBadges: true,
  agentsWaiting: true,
  allowAgentWorking: false,
};

// The peers that answer: the Thinkpad from the desktop, every online
// machine from a browser.
function statusOf(shell: SceneShell, deviceId: string) {
  const connected =
    deviceId === THINKPAD_ID ||
    (shell === "web" && deviceId === LOCAL_DEVICE_ID);
  return deviceStatusView(
    connected
      ? {
          phase: "connected",
          remoteDeviceId: deviceId,
          remoteAppVersion: FAKE_APP_VERSION,
        }
      : { phase: "stopped" },
  );
}

function peersOf(shell: SceneShell) {
  return accountDevices.filter(
    (device) => shell === "web" || device.deviceId !== LOCAL_DEVICE_ID,
  );
}

function deviceBadges(shell: SceneShell): Map<string, SidebarDeviceBadge> {
  return new Map(
    peersOf(shell).map((device) => {
      const { tone, reachable } = statusOf(shell, device.deviceId);
      const badge: SidebarDeviceBadge = {
        deviceId: device.deviceId,
        label: device.name,
        icon: device.icon ?? "desktop",
        tone,
        reachable,
      };
      return [device.deviceId, badge];
    }),
  );
}

function filterChoices(shell: SceneShell): DeviceRosterEntry[] {
  const local = accountDevices.find((d) => d.deviceId === LOCAL_DEVICE_ID);
  const here: DeviceRosterEntry[] =
    shell === "desktop" && local
      ? [
          {
            deviceId: LOCAL_DEVICE_ID,
            label: local.name,
            icon: local.icon ?? "desktop",
            isThisDevice: true,
            status: null,
            api: undefined,
          },
        ]
      : [];
  const peers = peersOf(shell).map(
    (device): DeviceRosterEntry => ({
      deviceId: device.deviceId,
      label: device.name,
      icon: device.icon ?? "desktop",
      isThisDevice: false,
      status: statusOf(shell, device.deviceId),
      api: undefined,
    }),
  );
  return [
    ...here,
    ...peers.filter((peer) => peer.status?.reachable),
    ...peers.filter((peer) => !peer.status?.reachable),
  ];
}

function remoteForests(shell: SceneShell): RemoteForestItem[] {
  return peersOf(shell).flatMap((device) => {
    const status = statusOf(shell, device.deviceId);
    const forest = forests[device.deviceId];
    if (!status.reachable || !forest) return [];
    return forest.projects.map((project) => ({
      deviceId: device.deviceId,
      deviceLabel: device.name,
      deviceIcon: device.icon ?? "desktop",
      reachable: status.reachable,
      tone: status.tone,
      project,
      worktrees: forest.worktrees[project.id] ?? [],
      pullRequests: unposedPullRequests(project.id),
      showPrimaryInInbox: false,
      worktreesError: false,
    }));
  });
}

const settled = <T,>(data: T) => ({
  data,
  error: null,
  isLoading: false,
  isPending: false,
  isError: false,
});

function localInputs(shell: SceneShell) {
  const forest = forests[LOCAL_DEVICE_ID];
  const projects = shell === "desktop" && forest ? forest.projects : [];
  return {
    projects,
    worktreeQueries: projects.map((project) =>
      settled(forest?.worktrees[project.id] ?? []),
    ),
    pullRequestQueries: projects.map((project) =>
      settled(unposedPullRequests(project.id)),
    ),
    configQueries: projects.map(() => settled(null)),
  };
}

function inboxModel(shell: SceneShell) {
  return buildInboxRows({
    ...localInputs(shell),
    remote: remoteForests(shell),
    mirrors: [],
    deviceBadges: deviceBadges(shell),
    openShelves: new Set(),
    hiddenPrefixes: [],
    groupedPrefixes: [],
    shutGroups: new Set(),
    allowAgentWorking: MARKS.allowAgentWorking,
    pinWaiting: MARKS.agentsWaiting,
  });
}

function treeModel(shell: SceneShell, openKey: string | null) {
  const local = localInputs(shell);
  const remote = remoteForests(shell);
  return buildSidebarRows({
    ...local,
    openKey,
    inline: null,
    worktreeSort: () => "name",
    order: projectGroupOrder({
      projects: local.projects,
      remote,
      sortMode: "manual",
      pinned: new Set(),
    }),
    openShelves: {
      agentWorking: new Set(),
      shelved: new Set(),
      hidden: new Set(),
    },
    hiddenPrefixes: [],
    allowAgentWorking: MARKS.allowAgentWorking,
    byPrefix: null,
    arrangeMode: false,
    byOwner: null,
    remote,
    mirrors: [],
    deviceBadges: deviceBadges(shell),
  });
}

// The projects on the desktop's list, as their rows (the New worktree
// list's targets).
export function projectRows() {
  return treeModel("desktop", null).rows.filter(
    (row) => row.kind === "project",
  );
}

// The home page's tiles over the desktop's forest (home/gridModel.ts),
// none visited yet.
export function sceneGrid() {
  const local = localInputs("desktop");
  const remote = remoteForests("desktop");
  return buildGrid({
    ...local,
    order: projectGroupOrder({
      projects: local.projects,
      remote,
      sortMode: "manual",
      pinned: new Set(),
    }),
    hiddenPrefixes: [],
    allowAgentWorking: MARKS.allowAgentWorking,
    byOwner: true,
    remote,
    mirrors: [],
    deviceBadges: deviceBadges("desktop"),
    visits: {},
  });
}

// The group key the open project goes by: shigoto-no-mori, this
// machine's on the desktop, the Studio Mac's from a browser.
function smGroupKey(shell: SceneShell): string {
  const project = forests[LOCAL_DEVICE_ID]?.projects[0];
  if (!project) throw new Error("no fixture project");
  return projectGroupKey(
    project,
    shell === "desktop" ? undefined : LOCAL_DEVICE_ID,
  );
}

function entryOf(
  worktreeId: string,
  selected: string | null,
  forwarded: boolean,
): WorktreeEntry {
  return {
    look: {
      isSelected: worktreeId === selected,
      activity: null,
      isDeleting: false,
    },
    open: noop,
    resident: null,
    forwardTip: forwarded ? "Forwarding 5173 to localhost:5173" : undefined,
    marks: MARKS,
  };
}

// A row as RowContent draws it, from the views alone.
function SceneRow({
  row,
  selected,
}: {
  row: SidebarRow;
  selected: string | null;
}) {
  switch (row.kind) {
    case "project":
      return (
        <ProjectRowView
          sortable={{}}
          arrangeMode={false}
          pickable={!row.expanded}
          current={false}
          folded={row.folded}
          branches={row.branches}
          isHovered={row.expanded}
          header={
            <ProjectHeaderView
              project={row.project}
              icon={
                <ProjectIconView
                  src={projectIconSrc(row.project.name)}
                  name={row.project.name}
                />
              }
              badges={<DeviceBadgeClusterView devices={row.devices} />}
              terrier={false}
              pinned={row.pinned}
              expanded={row.expanded}
              folded={row.folded}
            />
          }
          actions={
            <ProjectActionsView
              name={row.project.name}
              isHovered={row.expanded}
              triggerRef={{ current: null }}
              onOpenChange={noop}
              quickCreate={
                <QuickCreateButtonView
                  name={row.project.name}
                  isHovered={row.expanded}
                  creating={false}
                  onClick={noop}
                />
              }
              menu={null}
            />
          }
        />
      );
    case "owner-header":
      return (
        <FoldHeaderView
          label={row.label}
          count={row.count}
          expanded={row.expanded}
          onToggle={noop}
        />
      );
    case "worktree-group":
    case "inbox-group":
      return (
        <FoldHeaderView
          label={row.prefix}
          count={row.count}
          expanded={row.expanded}
          onToggle={noop}
        />
      );
    case "worktree":
    case "remote-worktree":
      return (
        <WorktreeRowView
          worktree={row.worktree}
          device={row.kind === "remote-worktree" ? row.device : undefined}
          mirror={row.kind === "worktree" ? row.mirror : undefined}
          pr={row.pr}
          stack={row.stack}
          stackRail={row.stackRail}
          shelf={row.shelf}
          entry={entryOf(
            row.worktree.id,
            selected,
            row.kind === "remote-worktree",
          )}
        />
      );
    case "inbox-worktree":
      return (
        <InboxRowView
          worktree={row.worktree}
          project={row.project}
          pr={row.pr}
          stack={row.stack}
          device={row.device}
          mirror={row.mirror}
          shelf={row.shelf}
          entry={entryOf(row.worktree.id, selected, row.device !== undefined)}
          projectIcon={
            <ProjectIconView
              src={projectIconSrc(row.project.name)}
              name={row.project.name}
              className="size-3"
            />
          }
        />
      );
    case "worktree-skeleton":
      return <WorktreesLoadingView />;
    case "worktree-error":
      return <WorktreesErrorView />;
    case "group-shelf":
    case "inbox-shelf":
      return (
        <ShelfRowView
          shelf={row.shelf}
          count={row.count}
          expanded={row.expanded}
          onToggle={noop}
        />
      );
    default:
      return assertNever(row);
  }
}

export function SceneSidebar({
  shell = "desktop",
  view,
  open = false,
  selected = null,
  footer = true,
  pathname = "/",
  takeover,
}: {
  shell?: SceneShell;
  view: SidebarView;
  // The tree inside shigoto-no-mori, rather than its list of projects.
  open?: boolean;
  // The worktree whose page is open, by id.
  selected?: string | null;
  // The footer, which the phone layout's forest page goes without.
  footer?: boolean;
  // The page on screen, whose footer button lights.
  pathname?: string;
  // A page's own list, in place of the forest (SidebarTakeoverView).
  takeover?: ReactNode;
}) {
  const hasLocalHost = shell === "desktop";
  const inbox = view === "inbox";
  const model = inbox
    ? inboxModel(shell)
    : treeModel(shell, open ? smGroupKey(shell) : null);
  return (
    <SidebarAsideView>
      <SidebarHeaderView
        hasLocalHost={hasLocalHost}
        showDevStyle={false}
        onRevealProd={noop}
      />
      <ForestSlotView takenOver={takeover !== undefined} handedOver={false}>
        <DeviceFilterBarView
          choices={filterChoices(shell)}
          selectedId={ALL_DEVICES}
          onPick={noop}
        />
        <ViewPaneView inbox={inbox} settled>
          {inbox ? (
            <InboxCreateRowView
              button={<NewWorktreeButtonView />}
              addProject={
                <AddProjectButtonView
                  outline
                  hasLocalHost={hasLocalHost}
                  onClick={noop}
                />
              }
            />
          ) : (
            <SidebarToolbarView
              onBack={open ? noop : undefined}
              projectSort={
                <ProjectSortMenuView
                  hasLocalHost={hasLocalHost}
                  sortMode="manual"
                  onSort={noop}
                  groupByOwner={false}
                  onGroupByOwner={noop}
                  onArrange={noop}
                />
              }
              addProject={
                <AddProjectButtonView
                  hasLocalHost={hasLocalHost}
                  onClick={noop}
                />
              }
            />
          )}
          {model.pinned && (
            <PinnedRowView kind={model.pinned.kind}>
              <SceneRow row={model.pinned} selected={selected} />
            </PinnedRowView>
          )}
          <SidebarScrollerView>
            <SidebarListView>
              {model.rows.map((row, index) => (
                <VirtualRowView key={row.key} row={row} index={index}>
                  <SceneRow row={row} selected={selected} />
                </VirtualRowView>
              ))}
            </SidebarListView>
            <SidebarEmptyStateView message={model.emptyMessage} />
          </SidebarScrollerView>
        </ViewPaneView>
        {footer && takeover === undefined && (
          <SidebarFooterView
            toggle={<SidebarViewToggleView view={view} onChange={noop} />}
            actions={
              <SidebarNavActionsView
                hasLocalHost={hasLocalHost}
                pathname={pathname}
                live={{ label: "Live", dot: null }}
                updateReady={false}
                onNavigate={noop}
              />
            }
          />
        )}
      </ForestSlotView>
      {takeover !== undefined && (
        <SidebarTakeoverSlotView>{takeover}</SidebarTakeoverSlotView>
      )}
    </SidebarAsideView>
  );
}
