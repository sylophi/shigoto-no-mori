// The lab's fixture world (../fixtures.ts) in the shapes the app's views
// take, for the scenes in this folder. Plain functions over plain data:
// a scene renders in Node (test/scenes.mts) and into the marketing site
// at build time, so nothing here may reach window, the router or a
// query.
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadgeView";
import type { DeviceFilterChoice } from "@/components/sidebar/DeviceFilterBarView";
import type { WorktreeRowLook } from "@/components/sidebar/rowState";
import {
  buildSidebarRows,
  deviceBadgeOf,
  projectGroupKey,
  projectGroupOrder,
} from "@/components/sidebar/buildSidebarRows";
import { buildInboxRows } from "@/components/sidebar/inbox/buildInboxRows";
import type { NewWorktreeTargetLook } from "@/components/sidebar/inbox/NewWorktreeButtonView";
import type { SidebarRowLookups } from "@/components/sidebar/SidebarListView";
import type { SidebarViewModel } from "@/components/sidebar/sidebarRow";
import type { ProjectShigomoriConfigQueries } from "@/hooks/config/useShigomoriConfig";
import type { ProjectPullRequestQueries } from "@/hooks/projects/useProjectPullRequests";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDeviceStatus } from "@/lib/remote/devices";
import { pullRequestStackPosition } from "@shared/pullRequestStack";
import type { Project, PullRequest, Worktree } from "@shared/schemas";
import {
  LOCAL_DEVICE_ID,
  THINKPAD_ID,
  accountDevices,
  forests,
  projectIconFor,
} from "../fixtures";
import { labPullRequestsFor } from "../pullRequestFixtures";

// The moment the scenes are drawn at, which "14m ago" counts back from.
// The fixtures date themselves back from the same moment (their module
// loads alongside this one), so the relative times hold on every build.
export const NOW = Date.now();

// A row in no state worth naming: not open, nothing running.
export const QUIET_LOOK: WorktreeRowLook = {
  isSelected: false,
  activity: null,
  isDeleting: false,
  title: undefined,
};

// A worktree by id, with the project and device it belongs to.
export function worktreeById(id: string): {
  worktree: Worktree;
  project: Project;
  deviceId: string;
} {
  for (const forest of Object.values(forests)) {
    for (const [projectId, worktrees] of Object.entries(forest.worktrees)) {
      const worktree = worktrees.find((candidate) => candidate.id === id);
      const project = forest.projects.find((p) => p.id === projectId);
      if (worktree && project) {
        return { worktree, project, deviceId: forest.deviceId };
      }
    }
  }
  throw new Error(`[scenes] no worktree ${id} in the fixtures`);
}

// A peer's badge, as the sidebar wears it. Connected unless posed
// otherwise, as the lab's default peer is.
export function badgeOf(
  deviceId: string,
  status: RemoteDeviceStatus = {
    phase: "connected",
    remoteDeviceId: deviceId,
    remoteAppVersion: "2.0.3",
  },
): SidebarDeviceBadge {
  const device = accountDevices.find((d) => d.deviceId === deviceId);
  if (!device) throw new Error(`[scenes] no device ${deviceId}`);
  const { tone, reachable } = deviceStatusView(status);
  return {
    deviceId,
    label: device.name,
    icon: device.icon ?? "laptop",
    tone,
    reachable,
  };
}

// A project's logo as the views take it (ProjectIconView's `src`): the
// fixture's, or null for the generated tile.
export function iconSrcOf(name: string): string | null {
  const icon = projectIconFor(name);
  return icon ? `data:${icon.mime};base64,${icon.base64}` : null;
}

// A branch's pull request and its place in a stack, with the stack open
// or (merged) landed.
export function pullRequestOf(
  projectId: string,
  branch: string,
  merged = false,
): {
  pr: PullRequest | undefined;
  stack: ReturnType<typeof pullRequestStackPosition>;
} {
  const prs = labPullRequestsFor(projectId, merged) as Record<
    string,
    PullRequest
  >;
  return { pr: prs[branch], stack: pullRequestStackPosition(prs, branch) };
}

// ---- the sidebar ----

// Which app draws the forest: the desktop window on Studio Mac, whose
// own projects are local there, or the web shell, a browser on the
// account to which every machine is a peer (lab/README.md).
export type LabShell = "desktop" | "web";

// This machine's name, the desktop lab's local device.
export const LOCAL_DEVICE_NAME =
  accountDevices.find((d) => d.deviceId === LOCAL_DEVICE_ID)?.name ?? "";

// The lab's default presence: the Thinkpad connected and the rest off,
// and on the web Studio Mac connected too.
function peerStatus(shell: LabShell, deviceId: string): RemoteDeviceStatus {
  const connected =
    deviceId === THINKPAD_ID ||
    (shell === "web" && deviceId === LOCAL_DEVICE_ID);
  return connected
    ? {
        phase: "connected",
        remoteDeviceId: deviceId,
        remoteAppVersion: "2.0.3",
      }
    : { phase: "stopped" };
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
  const here: DeviceFilterChoice[] =
    shell === "desktop"
      ? [
          {
            deviceId: LOCAL_DEVICE_ID,
            label: LOCAL_DEVICE_NAME,
            icon: "mini",
            status: null,
          },
        ]
      : [];
  const peers = peersOf(shell).map((device) => ({
    deviceId: device.deviceId,
    label: device.name,
    icon: device.icon ?? "laptop",
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
export function remoteForests(shell: LabShell): RemoteForestItem[] {
  return peersOf(shell).flatMap((device) => {
    const status = peerStatus(shell, device.deviceId);
    const forest = forests[device.deviceId];
    if (status.phase !== "connected" || !forest) return [];
    const { tone, reachable } = deviceStatusView(status);
    return forest.projects.map((project) => ({
      deviceId: device.deviceId,
      deviceLabel: device.name,
      deviceIcon: device.icon ?? "laptop",
      reachable,
      tone,
      project,
      worktrees: forest.worktrees[project.id] ?? [],
      pullRequests: labPullRequestsFor(project.id) as Record<
        string,
        PullRequest
      >,
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
    (project) => settled(labPullRequestsFor(project.id)),
  );
  // No project keeps a config of its own, so none shows its primary in
  // the inbox.
  const configQueries: ProjectShigomoriConfigQueries = projects.map(() =>
    settled(null),
  );
  return { projects, worktreeQueries, pullRequestQueries, configQueries };
}

// The inbox's rows, its shelves shut.
export function labInboxRows(shell: LabShell): SidebarViewModel {
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
export function labTreeRows(
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

// The ports the desktop forwards from a peer's worktree, as the lab
// poses them (the bridge's one pre-posed forward).
const LAB_FORWARDS = [
  {
    deviceId: THINKPAD_ID,
    worktreeId: "a1b2c3d4e5f6",
    remotePort: 5173,
    localPort: 5173,
  },
];

function forwardTipOf(deviceId: string, worktree: Worktree) {
  const pairs = LAB_FORWARDS.filter(
    (f) => f.deviceId === deviceId && f.worktreeId === worktree.id,
  ).map((f) => `${f.remotePort} to localhost:${f.localPort}`);
  return pairs.length > 0 ? `Forwarding ${pairs.join(", ")}` : undefined;
}

// What the rows look up, with `selected` (a worktree id) the one whose
// page is open, or null for none.
export function labRowLookups(
  shell: LabShell,
  selected: string | null,
): SidebarRowLookups {
  const open = selected === null ? null : worktreeById(selected);
  const openDevice = open && rowDeviceOf(shell, open.deviceId);
  return {
    now: NOW,
    showDeviceBadges: true,
    markTerrierProjects: false,
    lookOf: (worktree, deviceId) => ({
      ...QUIET_LOOK,
      isSelected:
        open !== null && worktree.id === selected && deviceId === openDevice,
      title: worktree.shelved ? "Shelved" : undefined,
    }),
    iconSrcOf: (project) => iconSrcOf(project.name),
    // Only the desktop forwards: the browser has no ports of its own.
    forwardTipOf: (worktree, deviceId) =>
      shell === "desktop" ? forwardTipOf(deviceId, worktree) : undefined,
    currentGroupKey:
      selected === null ? undefined : groupKeyOfWorktree(shell, selected),
    localDeviceLabel: shell === "desktop" ? LOCAL_DEVICE_NAME : undefined,
  };
}

// Where the inbox's New worktree can create: this machine's projects,
// then those of every connected peer that takes this device's commands.
export function labNewWorktreeTargets(
  shell: LabShell,
): NewWorktreeTargetLook[] {
  const local = localInputs(shell)
    .projects.filter((project) => project.pathExists !== false)
    .map((project) => ({
      key: project.id,
      name: project.name,
      iconSrc: iconSrcOf(project.name),
      device: undefined,
    }));
  const remote = remoteForests(shell)
    .filter((item) => forests[item.deviceId]?.grantsCaller === true)
    .map((item) => ({
      key: `${item.deviceId}/${item.project.id}`,
      name: item.project.name,
      iconSrc: iconSrcOf(item.project.name),
      device: deviceBadgeOf(item),
    }));
  return [...local, ...remote];
}
