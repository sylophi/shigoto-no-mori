// The lab's fixture world (../fixtures.ts) in the shapes the app's views
// take, for the scenes in this folder. Plain functions over plain data:
// a scene renders in Node (test/scenes.mts) and into the marketing site
// at build time, so nothing here may reach window, the router or a
// query.
import type { DevicesPageRow } from "@/components/remote/DevicesPageView";
import { deviceRowStatus } from "@/components/remote/deviceRegistryStatus";
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadgeView";
import type { WorktreeRowLook } from "@/components/sidebar/rowState";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDeviceStatus } from "@/lib/remote/devices";
import type { DeviceInfo } from "@shared/hub/protocol";
import { pullRequestStackPosition } from "@shared/pullRequestStack";
import type { Project, PullRequest, Worktree } from "@shared/schemas";
import { accountDevices, forests, projectIconFor } from "../fixtures";
import { labPullRequestsFor } from "../pullRequestFixtures";
import {
  LAB_APP_VERSION,
  LOCAL_DEVICE_ID,
  MINI_ID,
  THINKPAD_ID,
  WORKPC_ID,
} from "../fixtures";

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

// The Devices page's rows as the desktop Studio Mac sees them, the way
// the lab poses it by default (lab/bridge.ts): this device online with
// its tunnel up, letting the others control it and staying reachable,
// the Thinkpad connected with its dev server forwarded, the Mini and
// the Work PC away since their last session.
export function devicesPageRows(): DevicesPageRow[] {
  const thisDevice = deviceById(LOCAL_DEVICE_ID);
  const thinkpad = deviceById(THINKPAD_ID);
  const away = (id: string): DevicesPageRow => {
    const device = deviceById(id);
    return {
      ...rowBasics(device),
      status: deviceRowStatus(device, false, undefined, null, NOW),
      appVersion: "",
      // No session, so the peer has not said whether it takes orders.
      access: { granted: false, isLoading: true },
      // Not listed this session, so nothing is known yet.
      chips: [],
    };
  };
  return [
    {
      ...rowBasics(thisDevice),
      isThisDevice: true,
      status: deviceRowStatus(thisDevice, true, undefined, null, NOW),
      appVersion: LAB_APP_VERSION,
      tunnel: "up",
      chips: chipsOf(LOCAL_DEVICE_ID),
      acceptsCommands: true,
      keepReachable: true,
    },
    {
      ...rowBasics(thinkpad),
      status: deviceStatusView({
        phase: "connected",
        remoteDeviceId: THINKPAD_ID,
        remoteAppVersion: LAB_APP_VERSION,
      }),
      appVersion: LAB_APP_VERSION,
      chips: chipsOf(THINKPAD_ID),
      // The lab's one posed forward: the Thinkpad's dev server, with
      // two connections open.
      forwards: [
        {
          forwardId: "a3f19c2e77b04d5586e1f20c9ab34d61",
          remotePort: 5173,
          localPort: 5173,
          connCount: 2,
        },
      ],
    },
    away(MINI_ID),
    away(WORKPC_ID),
  ];
}

function deviceById(id: string): DeviceInfo {
  const device = accountDevices.find((d) => d.deviceId === id);
  if (!device) throw new Error(`[scenes] no device ${id}`);
  return device;
}

function rowBasics(
  device: DeviceInfo,
): Pick<
  DevicesPageRow,
  "deviceId" | "platform" | "isThisDevice" | "name" | "icon"
> {
  return {
    deviceId: device.deviceId,
    platform: device.platform,
    isThisDevice: false,
    name: device.name,
    icon: device.icon ?? "laptop",
  };
}

// A machine's project chips, in the order its forest lists them.
function chipsOf(deviceId: string): DevicesPageRow["chips"] {
  const forest = forests[deviceId];
  if (!forest) throw new Error(`[scenes] no forest on ${deviceId}`);
  return forest.projects.map((project) => ({
    projectId: project.id,
    name: project.name,
    worktrees: forest.worktrees[project.id]?.length ?? 0,
    iconSrc: iconSrcOf(project.name),
  }));
}
