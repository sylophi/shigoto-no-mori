// What one registry row says about a device's state, in one place so
// the summary line and the rows can never disagree.
//
// Two sources answer different halves of the question. The LIVE relay
// store (useRemoteDevices) knows whether a peer is in the roster right
// now and whether a direct session is up -- that is deviceStatusView's
// vocabulary and it is what the dot must show. The account registry's
// DeviceInfo knows when the machine was last seen at all, which is the
// only thing worth saying about a device that is simply switched off.
//
// "Off" is deliberately not what an offline row reads: a machine that
// is not running the app is the NORMAL state of a laptop in a bag, so
// it gets amber (calm, "not right now") plus the last-seen time, never
// the rose an error would earn.
import type { TunnelState } from "@shared/ipc/modules/relay";
import type { DeviceInfo } from "@shared/relay/protocol";
import { formatRelativeTime } from "@/lib/relativeTime";
import {
  deviceStatusView,
  type DeviceStatusView,
} from "@/lib/remote/deviceStatus";
import type { RemoteDevice } from "@/lib/remote/devices";

// The same triple every other device surface renders: tone, label,
// reachable. A registry row differs only in how it ANSWERS that, not in
// what it answers.
export type DeviceRowStatus = DeviceStatusView;

// What THIS device's row says about its tunnel endpoint, or null when
// there is nothing worth saying: "up" earns the muted marker beside
// the name, and "off" means the listener itself is down (signed out,
// or direct connections switched off), so a tunnel is not the missing
// piece. The copy states the CONSEQUENCE, not the state: data is
// direct or nothing, so without a tunnel a peer on another network
// cannot reach this machine at all, which is the single most common
// reason its forest never loads over there.
const LOCAL_ONLY =
  "other devices can only reach this machine over the local network.";

export function tunnelNote(state: TunnelState | undefined): string | null {
  switch (state) {
    case "no-binary":
      return `No tunnel: no usable cloudflared (see the log), so ${LOCAL_ONLY}`;
    case "unconfigured":
      return `No tunnel: the relay isn't set up for tunnels, so ${LOCAL_ONLY}`;
    case "error":
      return `Tunnel is down (retrying). Until it's back, ${LOCAL_ONLY}`;
    case "starting":
      return "Tunnel starting…";
    default:
      return null;
  }
}

export function deviceRowStatus(
  device: DeviceInfo,
  isThisDevice: boolean,
  relayDevice: RemoteDevice | undefined,
): DeviceRowStatus {
  // This machine is not a remote device to itself: it is running the
  // app the row is rendered by, so it is online by construction and
  // never appears in the relay store.
  if (isThisDevice) {
    return { tone: "emerald", label: "Online", reachable: true };
  }
  // A peer absent from the relay roster -- or with no store entry at
  // all, which is the same fact before the first reconcile lands -- is
  // off, not broken.
  if (relayDevice === undefined || relayDevice.status.phase === "stopped") {
    return {
      tone: "amber",
      // lastSeenAt is null until a device first connects, and a device
      // that has never been seen has no elapsed time to report.
      label:
        device.lastSeenAt === null
          ? "Offline"
          : `Offline · last seen ${formatRelativeTime(device.lastSeenAt)}`,
      reachable: false,
    };
  }
  // Every other phase (connected, online, connecting, reconnecting,
  // blocked) is a live transport fact, so the shared presentation
  // mapping owns it outright.
  return deviceStatusView(relayDevice.status);
}
