// The sidebar over the fixtures, as Sidebar draws it once settled at
// the fake host's default pose (nothing running, no update waiting):
// the brand header, the device filter, the view's own controls and
// rows, and the footer. The rows are the app's own (buildSidebarRows,
// buildInboxRows) over the fixture forests.
import { defaultBinding } from "../lib/keymap.ts";
import { buildGrid } from "../views/home/gridModel.ts";
import type { ReactNode } from "react";
import type { SidebarView } from "@shigomori/contracts/schemas";
import { AddProjectButtonView } from "../views/sidebar/AddProjectButtonView.tsx";
import { buildSidebarRows } from "../views/sidebar/buildSidebarRows.ts";
import { projectGroupOrder } from "../views/sidebar/projectGroupOrder.ts";
import type { SidebarDeviceBadge } from "../views/sidebar/DeviceBadgeView.tsx";
import { DeviceBadgeClusterView } from "../views/sidebar/DeviceBadgeView.tsx";
import {
  ALL_DEVICES,
  DeviceFilterBarView,
} from "../views/sidebar/DeviceFilterBarView.tsx";
import { FoldHeaderView } from "../views/sidebar/FoldHeaderView.tsx";
import { ProjectFolderHeaderView } from "../views/sidebar/ProjectFolderView.tsx";
import { buildInboxRows } from "../views/sidebar/inbox/buildInboxRows.ts";
import { InboxRowView } from "../views/sidebar/inbox/InboxRowView.tsx";
import { NewWorktreeButtonView } from "../views/sidebar/inbox/NewWorktreeButtonView.tsx";
import { ProjectActionsView } from "../views/sidebar/ProjectActionsView.tsx";
import { ProjectHeaderView } from "../views/sidebar/ProjectHeaderView.tsx";
import { ProjectRowView } from "../views/sidebar/ProjectRowView.tsx";
import { QuickCreateButtonView } from "../views/sidebar/QuickCreateButtonView.tsx";
import { ShelfRowView } from "../views/sidebar/ShelfRowView.tsx";
import {
  ForestSlotView,
  InboxCreateRowView,
  PinnedRowView,
  SidebarAsideView,
  SidebarEmptyStateView,
  SidebarScrollerView,
  ViewPaneView,
} from "../views/sidebar/SidebarFrameView.tsx";
import { SidebarTakeoverSlotView } from "../views/sidebar/SidebarTakeoverView.tsx";
import {
  SidebarFooterView,
  SidebarGuideMenuView,
  SidebarNavActionsView,
  SidebarViewToggleView,
} from "../views/sidebar/SidebarFooterView.tsx";
import { SidebarHeaderView } from "../views/sidebar/SidebarHeaderView.tsx";
import {
  SidebarListView,
  VirtualRowView,
  WorktreesErrorView,
  WorktreesLoadingView,
} from "../views/sidebar/SidebarRowsView.tsx";
import type { SidebarRow } from "../views/sidebar/sidebarRow.ts";
import { SidebarToolbarView } from "../views/sidebar/SidebarToolbarView.tsx";
import { ProjectSortMenuView } from "../views/sidebar/SidebarToolbarView.tsx";
import type { WorktreeEntry } from "../views/sidebar/WorktreeEntryView.tsx";
import { WorktreeMenuView } from "../views/sidebar/WorktreeMenuView.tsx";
import { WorktreeRowView } from "../views/sidebar/WorktreeRowView.tsx";
import { ProjectIconView } from "../views/shared/ProjectIconView.tsx";
import type { DeviceRosterEntry } from "../lib/deviceRoster.ts";
import type { SidebarMarks } from "../views/sidebar/WorktreeEntryView.tsx";
import { type ForestItem, projectGroupKey } from "../lib/forest.ts";
import { deviceStatusView } from "../lib/deviceStatus.ts";
import { assertNever } from "../lib/utils.ts";
import {
  accountDevices,
  forests,
  LOCAL_DEVICE_ID,
  MACBOOK_ID,
} from "../fixtures/fixtures.ts";
import { unposedPullRequests } from "../fixtures/pullRequestFixtures.ts";
import { noop } from "./world.ts";

// Which app draws the forest: the desktop window on Studio Mac, whose
// own projects are local there, or the web shell, a browser to which
// every machine is a peer.
type SceneShell = "desktop" | "web";

// What a settled sidebar marks with the default settings.
const MARKS: SidebarMarks = {
  terrier: true,
  deviceBadges: true,
  agentsWaiting: true,
  allowAgentWorking: false,
};

// The peers that answer: the MacBook from the desktop, every online
// machine from a browser.
function statusOf(shell: SceneShell, deviceId: string) {
  const connected =
    deviceId === MACBOOK_ID ||
    (shell === "web" && deviceId === LOCAL_DEVICE_ID);
  return deviceStatusView(
    connected ? { phase: "connected" } : { phase: "stopped" },
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
    }),
  );
  return [
    ...here,
    ...peers.filter((peer) => peer.status?.reachable),
    ...peers.filter((peer) => !peer.status?.reachable),
  ];
}

// Every device's projects as the forest's items, this machine's first:
// Studio Mac's own on the desktop, then every peer that answers.
function forestItems(shell: SceneShell): ForestItem[] {
  const here = accountDevices.find((d) => d.deviceId === LOCAL_DEVICE_ID);
  const devices = [
    ...(shell === "desktop" && here ? [here] : []),
    ...peersOf(shell),
  ];
  return devices.flatMap((device) => {
    const isThisDevice = shell === "desktop" && device === here;
    const status = isThisDevice
      ? { tone: "emerald" as const, reachable: true }
      : statusOf(shell, device.deviceId);
    const forest = forests[device.deviceId];
    if (!status.reachable || !forest) return [];
    return forest.projects.map(
      (project): ForestItem => ({
        device: {
          deviceId: device.deviceId,
          label: device.name,
          icon: device.icon ?? "desktop",
          tone: status.tone,
          reachable: status.reachable,
          isThisDevice,
        },
        project,
        worktrees: forest.worktrees[project.id] ?? [],
        listing: "ready",
        pullRequests: unposedPullRequests(project.id),
        showPrimaryInInbox: false,
      }),
    );
  });
}

function inboxModel(shell: SceneShell) {
  return buildInboxRows({
    items: forestItems(shell),
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

// The projects as stored, none pinned or in a folder.
function manualOrder(items: readonly ForestItem[]) {
  return projectGroupOrder({
    items,
    sortMode: "manual",
    pinned: new Set(),
    folders: new Map(),
  });
}

function treeModel(shell: SceneShell, openKey: string | null) {
  const items = forestItems(shell);
  return buildSidebarRows({
    items,
    openKey,
    inline: null,
    worktreeSort: () => "name",
    order: manualOrder(items),
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
    shutFolders: new Set(),
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
  const items = forestItems("desktop");
  return buildGrid({
    items,
    order: manualOrder(items),
    hiddenPrefixes: [],
    allowAgentWorking: MARKS.allowAgentWorking,
    byOwner: true,
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
      terminal: null,
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
              icon={<ProjectIconView src={null} name={row.project.name} />}
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
    case "project-folder":
      return (
        <ProjectFolderHeaderView
          name={row.name}
          count={row.count}
          expanded={row.expanded}
          onToggle={noop}
          onRename={noop}
          onUngroup={noop}
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
      return (
        <WorktreeMenuView
          row={
            <WorktreeRowView
              worktree={row.worktree}
              device={row.device}
              mirror={row.mirror}
              pr={row.pr}
              stack={row.stack}
              stackRail={row.stackRail}
              shelf={row.shelf}
              entry={entryOf(
                row.worktree.id,
                selected,
                row.device !== undefined,
              )}
            />
          }
          onOpenChange={noop}
        >
          {null}
        </WorktreeMenuView>
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
              src={null}
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
  const addProjectKeys = hasLocalHost
    ? defaultBinding("addProject").aria
    : undefined;
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
                  keys={addProjectKeys}
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
                <AddProjectButtonView keys={addProjectKeys} onClick={noop} />
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
            toggle={
              <SidebarViewToggleView
                view={view}
                onChange={noop}
                keys={defaultBinding("sidebarLayout").aria}
              />
            }
            actions={
              <>
                {hasLocalHost && (
                  <SidebarGuideMenuView
                    choices={{ harnesses: ["claude", "codex"], terminals: [] }}
                    onPick={noop}
                  />
                )}
                <SidebarNavActionsView
                  hasLocalHost={hasLocalHost}
                  pathname={pathname}
                  live={{ label: "Live", dot: null }}
                  updateReady={false}
                  onNavigate={noop}
                />
              </>
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
