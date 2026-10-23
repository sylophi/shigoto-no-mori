// What a registry row says about a device: the dot from the live hub
// store, and for an offline peer the registry's last-seen time, in
// slate rather than rose, since a laptop in a bag is the normal case.
// Amber is a dial in flight.
import type { HubStatus, TunnelState } from "@shigomori/contracts/modules/hub";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import { formatRelativeTime } from "../../lib/relativeTime.ts";
import {
  deviceStatusView,
  type DeviceStatusView,
  type RemoteDeviceStatus,
} from "../../lib/deviceStatus.ts";

export type DeviceRowStatus = DeviceStatusView;

// This device's tunnel note, or null ("up" joins the state phrase,
// "off" means the listener is down). It states the consequence, the
// commonest reason a peer on another network can't load this forest.
const LOCAL_ONLY =
  "other devices can only reach this machine over the local network.";

export function tunnelNote(state: TunnelState | undefined): string | null {
  switch (state) {
    case "no-binary":
      return `No tunnel: no usable cloudflared (see the log), so ${LOCAL_ONLY}`;
    case "unconfigured":
      return `No tunnel: the device hub isn't set up for tunnels, so ${LOCAL_ONLY}`;
    case "error":
      return `Tunnel is down (retrying). Until it's back, ${LOCAL_ONLY}`;
    case "starting":
      return `Tunnel starting… Until it's up, ${LOCAL_ONLY}`;
    default:
      return null;
  }
}

// This machine is never in the hub store: its row reads its own socket,
// "Online" when connected (the roster word; "Connected" is a peer's
// session). No snapshot yet (null) reads as online, the common case.
export function thisDeviceRowStatus(
  socket: HubStatus["socket"] | null,
): DeviceRowStatus {
  if (socket === null || socket.phase === "connected") {
    return { tone: "emerald", label: "Online", reachable: true };
  }
  return deviceStatusView(socket);
}

export function peerRowStatus(
  device: DeviceInfo,
  // The peer's status in the live hub store, undefined before it has
  // an entry.
  hubStatus: RemoteDeviceStatus | undefined,
  // The registry's clock (useNow), for the "last seen" label.
  now: number,
): DeviceRowStatus {
  // A peer absent from the roster, or with no store entry yet (the same
  // fact before the first reconcile lands), is off, not broken.
  if (hubStatus === undefined || hubStatus.phase === "stopped") {
    return {
      tone: "slate",
      // lastSeenAt is null until a device first connects, and a device
      // that has never been seen has no elapsed time to report.
      label:
        device.lastSeenAt === null
          ? "Offline"
          : `Last seen ${formatRelativeTime(device.lastSeenAt, now)}`,
      reachable: false,
    };
  }
  return deviceStatusView(hubStatus);
}
