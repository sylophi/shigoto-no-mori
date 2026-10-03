// The Devices page's data (../DevicesPane.tsx).
import type { HostChip } from "@/components/remote/deviceHostChips";
import {
  type DeviceRowStatus,
  deviceRowStatus,
} from "@/components/remote/deviceRegistryStatus";
import type { CommandAccess } from "@/hooks/remote/useCommandAccess";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { DeviceInfo } from "@shared/hub/protocol";
import type { TunnelState } from "@shared/ipc/modules/hub";
import type { PortForwardSummary } from "@shared/ipc/modules/portForward";
import {
  LAB_APP_VERSION,
  LOCAL_DEVICE_ID,
  MINI_ID,
  THINKPAD_ID,
  WORKPC_ID,
  forests,
  labForwards,
} from "../../fixtures";
import { NOW, connectedTo, deviceById, iconSrcOf } from "./index";

// One machine's row.
export interface DevicesPageRow {
  device: DeviceInfo;
  isThisDevice: boolean;
  status: DeviceRowStatus;
  // The app version it runs, "" when unknown.
  appVersion: string;
  // Its projects, each with its logo (ProjectIconView's `src`).
  chips: readonly (HostChip & { iconSrc: string | null })[];
  // This device's tunnel endpoint state and its two switches.
  tunnel?: TunnelState;
  acceptsCommands?: boolean;
  keepReachable?: boolean;
  // Whether this device may run commands on the peer, and the forwards
  // it holds open to it.
  access: Pick<CommandAccess, "granted" | "isLoading">;
  forwards: readonly PortForwardSummary[];
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

// A peer with no session since this one started: it has not said
// whether it takes orders, and nothing of it has been listed.
function away(deviceId: string): DevicesPageRow {
  const device = deviceById(deviceId);
  return {
    device,
    isThisDevice: false,
    status: deviceRowStatus(device, false, undefined, null, NOW),
    appVersion: "",
    chips: [],
    access: { granted: false, isLoading: true },
    forwards: [],
  };
}

// The Devices page's rows as the desktop Studio Mac sees them, the way
// the lab poses it by default (lab/bridge.ts): this device online with
// its tunnel up, letting the others control it and staying reachable,
// the Thinkpad connected with its dev server forwarded, the Mini and
// the Work PC away since their last session.
export function devicesPageRows(): DevicesPageRow[] {
  const thisDevice = deviceById(LOCAL_DEVICE_ID);
  return [
    {
      device: thisDevice,
      isThisDevice: true,
      status: deviceRowStatus(thisDevice, true, undefined, null, NOW),
      appVersion: LAB_APP_VERSION,
      chips: chipsOf(LOCAL_DEVICE_ID),
      tunnel: "up",
      acceptsCommands: true,
      keepReachable: true,
      access: { granted: true, isLoading: false },
      forwards: [],
    },
    {
      device: deviceById(THINKPAD_ID),
      isThisDevice: false,
      status: deviceStatusView(connectedTo(THINKPAD_ID)),
      appVersion: LAB_APP_VERSION,
      chips: chipsOf(THINKPAD_ID),
      access: { granted: true, isLoading: false },
      forwards: labForwards.filter(
        (forward) => forward.deviceId === THINKPAD_ID,
      ),
    },
    away(MINI_ID),
    away(WORKPC_ID),
  ];
}
