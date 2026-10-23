// A device's phase as a tone and a label, the same on every surface.
import type { StatusTone } from "../primitives/status-dot.tsx";
import type { HubStatus } from "@shigomori/contracts/modules/hub";

// The hub socket's phases plus two of the renderer's: "online" is
// rostered with no direct session yet, so not connected (a roster fact
// claims no data wire), and "notSharing" is a session whose peer's
// sharing switch is off, so it serves nothing and gets no api.
export type RemoteDeviceStatus =
  | HubStatus["socket"]
  | { phase: "online" }
  | { phase: "notSharing" };

export type DeviceStatusView = {
  tone: StatusTone;
  label: string;
  // Whether the device's api works now: only while a direct session is
  // up ("connected"). The one test for reach-gated controls (editing a
  // peer's settings, offering it as a new-worktree target).
  reachable: boolean;
};

// The presentation half: phase to tone and label. `reachable` is derived
// once below, never per arm, so a new phase cannot ship a pair that
// disagrees with its label.
function presentationOf(status: RemoteDeviceStatus): {
  tone: StatusTone;
  label: string;
} {
  switch (status.phase) {
    case "connected":
      return { tone: "emerald", label: "Connected" };
    // Rostered, no direct session yet: the keeper dials on presence and
    // redials forever, so it reads as the dial it is. A peer whose
    // tunnel is starting can sit here until it routes. Amber, like
    // reconnecting: both are a dial still in flight.
    case "online":
    case "connecting":
    case "idle":
      return { tone: "amber", label: "Connecting" };
    case "backoff":
      return { tone: "amber", label: "Reconnecting" };
    case "blocked":
      return { tone: "rose", label: "Blocked" };
    case "stopped":
      return { tone: "slate", label: "Off" };
    // Connected, but its sharing switch is off.
    case "notSharing":
      return { tone: "slate", label: "Not sharing" };
  }
}

// The machine this window runs on: always here, with no connection to
// describe.
export const THIS_DEVICE_VIEW: DeviceStatusView = {
  tone: "emerald",
  label: "This device",
  reachable: true,
};

// The same machine while its host is down (stopped, or stopped by the
// shell's watchdog) until a new one answers: its pages can't load.
export const THIS_DEVICE_NOT_RESPONDING_VIEW: DeviceStatusView = {
  tone: "rose",
  label: "Not responding",
  reachable: false,
};

// A device's name and its state, in one spelling ("Thinkpad,
// Connected", "Studio Mac, This device"): the chip's tooltip and a
// filter pill's accessible name.
export function deviceTitle(
  label: string,
  status: DeviceStatusView | null,
): string {
  return `${label}, ${(status ?? THIS_DEVICE_VIEW).label}`;
}

export function deviceStatusView(status: RemoteDeviceStatus): DeviceStatusView {
  return {
    ...presentationOf(status),
    // Only a live direct session counts: every use of a peer's api
    // rides one, and "online" (rostered, no session yet) rejects until
    // the dial lands, so it must not be offered as reachable.
    reachable: status.phase === "connected",
  };
}
