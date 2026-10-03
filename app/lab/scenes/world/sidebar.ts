// The sidebar's data (../LabSidebar.tsx): the lab's default presence
// through the app's own row builders.
import {
  buildSidebarRows,
  projectGroupKey,
  projectGroupOrder,
} from "@/components/sidebar/buildSidebarRows";
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadgeView";
import type { DeviceFilterChoice } from "@/components/sidebar/DeviceFilterBarView";
import { buildInboxRows } from "@/components/sidebar/inbox/buildInboxRows";
import { inboxCreateTargets } from "@/components/sidebar/inbox/createTargets";
import type { NewWorktreeTargetLook } from "@/components/sidebar/inbox/NewWorktreeButtonView";
import { rowTitle } from "@/components/sidebar/rowState";
import type { SidebarViewModel } from "@/components/sidebar/sidebarRow";
import type { ProjectShigomoriConfigQueries } from "@/hooks/config/useShigomoriConfig";
import type { ProjectPullRequestQueries } from "@/hooks/projects/useProjectPullRequests";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDeviceStatus } from "@/lib/remote/devices";
import { worktreeForwardTip } from "@/lib/remote/forwardTip";
import {
  LOCAL_DEVICE_ID,
  THINKPAD_ID,
  accountDevices,
  forests,
  labForwards,
} from "../../fixtures";
import {
  type LabShell,
  NOW,
  badgeOf,
  connectedTo,
  deviceById,
  deviceIconOf,
  iconSrcOf,
  pullRequestsOf,
  worktreeById,
} from "./index";
import type { SidebarRowLookups } from "../SidebarRows";

// The lab's default presence: the Thinkpad connected and the rest off,
// and on the web Studio Mac connected too.
function peerStatus(shell: LabShell, deviceId: string): RemoteDeviceStatus {
  const connected =
    deviceId === THINKPAD_ID ||
    (shell === "web" && deviceId === LOCAL_DEVICE_ID);
  return connected ? connectedTo(deviceId) : { phase: "stopped" };
}

// The shell's peers, in the account's order.
function peersOf(shell: LabShell) {
  return accountDevices.filter(
    (device) => shell === "web" || device.deviceId !== LOCAL_DEVICE_ID,
  );
}

// Every peer's badge by device id (useDeviceBadges).
function deviceBadges(shell: LabShell): Map<string, SidebarDeviceBadge> {
  return new Map(
    peersOf(shell).map((device) => [
      device.deviceId,
      badgeOf(device.deviceId, peerStatus(shell, device.deviceId)),
    ]),
  );
}

// The device filter's machines (useDeviceRoster): this one first, then
// the reachable peers, then the rest.
export function deviceFilterChoices(shell: LabShell): DeviceFilterChoice[] {
  const local = deviceById(LOCAL_DEVICE_ID);
  const here: DeviceFilterChoice[] =
    shell === "desktop"
      ? [
          {
            deviceId: LOCAL_DEVICE_ID,
            label: local.name,
            icon: deviceIconOf(local),
            status: null,
          },
        ]
      : [];
  const peers = peersOf(shell).map((device) => ({
    deviceId: device.deviceId,
    label: device.name,
    icon: deviceIconOf(device),
    status: deviceStatusView(peerStatus(shell, device.deviceId)),
  }));
  return [
    ...here,
    ...peers.filter((peer) => peer.status.reachable),
    ...peers.filter((peer) => !peer.status.reachable),
  ];
}

// The peers' forests the sidebar merges in (useRemoteForests): one item
// per project on every connected peer. The ones that are off have
// never been listed in the lab, so they have nothing cached to show.
function remoteForests(shell: LabShell): RemoteForestItem[] {
  return peersOf(shell).flatMap((device) => {
    const status = peerStatus(shell, device.deviceId);
    const forest = forests[device.deviceId];
    if (status.phase !== "connected" || !forest) return [];
    const { tone, reachable } = deviceStatusView(status);
    return forest.projects.map((project) => ({
      deviceId: device.deviceId,
      deviceLabel: device.name,
      deviceIcon: deviceIconOf(device),
      reachable,
      tone,
      project,
      worktrees: forest.worktrees[project.id] ?? [],
      pullRequests: pullRequestsOf(project.id),
      showPrimaryInInbox: false,
      worktreesError: false,
    }));
  });
}

// A settled query's result as the fan-outs hand it to the builders
// (combineFanOut), standing in for the live one.
const settled = <T>(data: T) => ({
  data,
  error: null,
  isLoading: false,
  isPending: false,
});

// This machine's projects and their listings, in the stored (manual)
// order the lab sorts by. The web shell has none.
function localInputs(shell: LabShell) {
  const forest = forests[LOCAL_DEVICE_ID];
  const projects = shell === "desktop" && forest ? forest.projects : [];
  const worktreeQueries: ProjectWorktreeQueries = projects.map((project) =>
    settled(forest?.worktrees[project.id] ?? []),
  );
  const pullRequestQueries: ProjectPullRequestQueries = projects.map(
    (project) => settled(pullRequestsOf(project.id)),
  );
  // No project keeps a config of its own, so none shows its primary in
  // the inbox.
  const configQueries: ProjectShigomoriConfigQueries = projects.map(() =>
    settled(null),
  );
  return { projects, worktreeQueries, pullRequestQueries, configQueries };
}

// The inbox's rows, its shelves shut.
export function inboxRows(shell: LabShell): SidebarViewModel {
  return buildInboxRows({
    ...localInputs(shell),
    remote: remoteForests(shell),
    mirrors: [],
    deviceBadges: deviceBadges(shell),
    openShelves: new Set(),
    hiddenPrefixes: [],
  });
}

// The device a worktree is named under in a shell's rows: undefined for
// the desktop's own.
function rowDeviceOf(shell: LabShell, deviceId: string): string | undefined {
  return shell === "desktop" && deviceId === LOCAL_DEVICE_ID
    ? undefined
    : deviceId;
}

// The group key (projectGroupKey) of the project a worktree belongs to.
export function groupKeyOfWorktree(shell: LabShell, worktreeId: string) {
  const { project, deviceId } = worktreeById(worktreeId);
  return projectGroupKey(project, rowDeviceOf(shell, deviceId));
}

// The tree's rows, inside the project `openKey` names or on the list
// of projects (null), its worktrees by name and its shelves shut.
export function treeRows(
  shell: LabShell,
  openKey: string | null,
): SidebarViewModel {
  const local = localInputs(shell);
  const remote = remoteForests(shell);
  return buildSidebarRows({
    ...local,
    openKey,
    worktreeSort: "name",
    order: projectGroupOrder({
      projects: local.projects,
      remote,
      sortMode: "manual",
    }),
    openShelves: { shelved: new Set(), hidden: new Set() },
    hiddenPrefixes: [],
    arrangeMode: false,
    remote,
    mirrors: [],
    deviceBadges: deviceBadges(shell),
  });
}

// What the rows look up, with `selected` (a worktree id) the one whose
// page is open, or null for none.
export function rowLookups(
  shell: LabShell,
  selected: string | null,
): SidebarRowLookups {
  const open = selected === null ? null : worktreeById(selected);
  const openDevice = open && rowDeviceOf(shell, open.deviceId);
  return {
    now: NOW,
    showDeviceBadges: true,
    // Nothing runs in the lab's worktrees.
    lookOf: (worktree, deviceId) => ({
      isSelected:
        open !== null && worktree.id === selected && deviceId === openDevice,
      activity: null,
      isDeleting: false,
      title: rowTitle(null, false, worktree.shelved),
    }),
    iconSrcOf: (project) => iconSrcOf(project.name),
    // Only the desktop forwards: the browser has no ports of its own.
    forwardTipOf: (worktree, deviceId) =>
      shell === "desktop"
        ? worktreeForwardTip(labForwards, deviceId, worktree)
        : undefined,
    currentGroupKey:
      selected === null ? undefined : groupKeyOfWorktree(shell, selected),
    localDeviceLabel:
      shell === "desktop" ? deviceById(LOCAL_DEVICE_ID).name : undefined,
  };
}

// Where the inbox's New worktree can create (inboxCreateTargets): a peer
// takes it when it lets this device control it.
export function newWorktreeTargets(shell: LabShell): NewWorktreeTargetLook[] {
  return inboxCreateTargets(
    localInputs(shell).projects,
    remoteForests(shell),
    (deviceId) => (forests[deviceId]?.grantsCaller ? true : undefined),
  ).map((target) => ({
    key: target.key,
    name: target.project.name,
    iconSrc: iconSrcOf(target.project.name),
    device: target.peer?.badge,
  }));
}
