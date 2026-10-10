// The fake host's fixture world (../fake-host/fixtures.ts) in the
// shapes the app's views take, for the scenes in this folder. Plain
// functions over plain data: a scene renders in Node
// (test/scenes.mts) and into the marketing site at build time, so
// nothing here may reach window, the router or a query.
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import type { DeviceBarTab } from "@shigomori/ui/views/shared/DeviceTabBarView.tsx";
import {
  deviceStatusView,
  type DeviceStatusView,
} from "@shigomori/ui/lib/deviceStatus.ts";
import {
  accountDevices,
  FAKE_APP_VERSION,
  forests,
  LOCAL_DEVICE_ID,
  projectIconFor,
} from "../fake-host/fixtures";

// A device of the account, as the views draw it: this device has no
// connection to show, a peer's is its presence.
export type SceneDevice = {
  deviceId: string;
  label: string;
  icon: DeviceIcon;
  status: DeviceStatusView;
};

const devices: SceneDevice[] = accountDevices.map((device) => ({
  deviceId: device.deviceId,
  label: device.name,
  icon: device.icon ?? "desktop",
  status: deviceStatusView(
    device.online
      ? {
          phase: "connected",
          remoteDeviceId: device.deviceId,
          remoteAppVersion: FAKE_APP_VERSION,
        }
      : { phase: "stopped" },
  ),
}));

export function deviceById(deviceId: string): SceneDevice {
  const device = devices.find((d) => d.deviceId === deviceId);
  if (!device) throw new Error(`no fixture device ${deviceId}`);
  return device;
}

// The device tabs a page leads with: this device first, wearing its
// glyph alone, then the peers.
export function deviceTabs(deviceIds: readonly string[]): DeviceBarTab[] {
  return deviceIds.map((deviceId) => {
    const device = deviceById(deviceId);
    return {
      ...device,
      status: deviceId === LOCAL_DEVICE_ID ? null : device.status,
    };
  });
}

// A project of a device's forest, by name.
export function projectNamed(deviceId: string, name: string): Project {
  const project = forests[deviceId]?.projects.find((p) => p.name === name);
  if (!project) throw new Error(`no fixture project ${name} on ${deviceId}`);
  return project;
}

// A worktree of a project, by name.
export function worktreeNamed(project: Project, name: string): Worktree {
  for (const forest of Object.values(forests)) {
    const worktree = forest.worktrees[project.id]?.find((w) => w.name === name);
    if (worktree) return worktree;
  }
  throw new Error(`no fixture worktree ${name} in ${project.name}`);
}

// A project's icon as ProjectIconView takes it: the fixture's logo as a
// data URL, or null for a repo with none (the generated tile).
export function projectIconSrc(name: string): string | null {
  const icon = projectIconFor(name);
  return icon === null ? null : `data:${icon.mime};base64,${icon.base64}`;
}

// A villager's face, standing in for the downloaded villager data,
// which a checkout may not have: a round face in the theme's leaf.
export const FACE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="17" r="12" fill="#e8c27a"/><circle cx="11.5" cy="15" r="1.6" fill="#4a3b2a"/><circle cx="20.5" cy="15" r="1.6" fill="#4a3b2a"/><path d="M12 21q4 3 8 0" stroke="#4a3b2a" stroke-width="1.4" fill="none" stroke-linecap="round"/><path d="M6 9l4 4M26 9l-4 4" stroke="#b98a3e" stroke-width="3" stroke-linecap="round"/></svg>',
)}`;
