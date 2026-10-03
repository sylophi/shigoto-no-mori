// The lab's fixture world (../../fixtures.ts) in the shapes the app's
// views take, for the scenes in this folder: here what every scene
// reads, and beside it what each part of the app adds (sidebar.ts,
// worktreePage.ts, devicesPage.ts, transplant.ts). Plain functions over
// plain data: a scene renders in Node (test/scenes.mts) and into the
// marketing site at build time, so nothing here may reach window, the
// router or a query.
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadgeView";
import type { WorktreeRowLook } from "@/components/sidebar/rowState";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDeviceStatus } from "@/lib/remote/devices";
import {
  type DeviceIcon,
  MACHINE_FALLBACK_ICON,
} from "@shared/account/deviceIcon";
import type { DeviceInfo } from "@shared/hub/protocol";
import { pullRequestStackPosition } from "@shared/pullRequestStack";
import type { Project, PullRequest, Worktree } from "@shared/schemas";
import {
  LAB_APP_VERSION,
  accountDevices,
  forests,
  labDisks,
  projectIconFor,
} from "../../fixtures";
import { labUnposedPullRequests } from "../../pullRequestFixtures";

// The moment the scenes are drawn at, which "14m ago" counts back from.
// The fixtures date themselves back from the same moment (their module
// loads alongside this one), so the relative times hold on every build.
export const NOW = Date.now();

// Which app draws the forest: the desktop window on Studio Mac, whose
// own projects are local there, or the web shell, a browser on the
// account to which every machine is a peer (lab/README.md).
export type LabShell = "desktop" | "web";

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

// A device of the account, by id.
export function deviceById(id: string): DeviceInfo {
  const device = accountDevices.find((d) => d.deviceId === id);
  if (!device) throw new Error(`[scenes] no device ${id}`);
  return device;
}

// The icon a device wears: its own, or the app's stand-in until it
// picks one.
export function deviceIconOf(device: DeviceInfo): DeviceIcon {
  return device.icon ?? MACHINE_FALLBACK_ICON;
}

// The folder a device's paths shorten against (~/...).
export function homeOf(deviceId: string): string {
  const disk = labDisks[deviceId];
  if (!disk) throw new Error(`[scenes] no disk for ${deviceId}`);
  return disk.home;
}

// A peer with a session open, on the lab's own version.
export function connectedTo(deviceId: string): RemoteDeviceStatus {
  return {
    phase: "connected",
    remoteDeviceId: deviceId,
    remoteAppVersion: LAB_APP_VERSION,
  };
}

// A peer's badge, as the sidebar wears it. Connected unless posed
// otherwise, as the lab's default peer is.
export function badgeOf(
  deviceId: string,
  status: RemoteDeviceStatus = connectedTo(deviceId),
): SidebarDeviceBadge {
  const device = deviceById(deviceId);
  const { tone, reachable } = deviceStatusView(status);
  return {
    deviceId,
    label: device.name,
    icon: deviceIconOf(device),
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

// A project's pull requests by head branch, the lab's stack as it
// stands with nothing posed.
export function pullRequestsOf(projectId: string): Record<string, PullRequest> {
  return labUnposedPullRequests(projectId);
}

// A branch's pull request and its place in a stack.
export function pullRequestOf(projectId: string, branch: string) {
  const prs = pullRequestsOf(projectId);
  return { pr: prs[branch], stack: pullRequestStackPosition(prs, branch) };
}
