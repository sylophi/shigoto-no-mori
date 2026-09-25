// Presentation mapping for a remote device's status. One place turns
// the phase into a tone and a label so the settings
// chip, the sidebar badge and the devices page read the same. Tones stay
// within the four raw families the theme remaps (emerald, rose, amber,
// sky) plus slate for off, per the doubutsu contract.
import type { StatusTone } from "@/components/ui/status-dot";
import type { RemoteDeviceStatus } from "./devices";

export type DeviceStatusView = {
  // Exactly the closed tone set the StatusDot primitive draws, so every
  // phase maps to a renderable dot by construction.
  tone: StatusTone;
  label: string;
  // True when using the device's api can work right now: a direct
  // session is up ("connected"), or the peer is in the hub roster
  // and the keeper is establishing one ("online"). The ONE vocabulary
  // for reach-gated affordances (editing a peer's settings, offering it
  // as a new-worktree target), so components stop each spelling the same
  // predicate their own way.
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
    // The peer is in the hub roster but no direct session is
    // established (data is direct or nothing). "Online" is reserved
    // for a peer this window can actually use, so the roster fact
    // alone reads as the dial it is: the keeper dials on presence and
    // redials forever, and success flips this to "Connected" on its
    // own. A brand-new tunnel (or a browser waiting on one) can sit
    // here for a while, which is why the label says what is being
    // waited for rather than claiming presence.
    case "online":
    case "connecting":
    case "idle":
      return { tone: "sky", label: "Connecting" };
    case "backoff":
      return { tone: "amber", label: "Reconnecting" };
    case "blocked":
      return { tone: "rose", label: "Blocked" };
    case "stopped":
      return { tone: "slate", label: "Off" };
  }
}

// The machine this window runs on, in the same vocabulary: it has no
// connection to describe, so it is always here, and every surface
// that tags it (the settings header, its nav row) reads this one
// entry rather than spelling "This device" and emerald on its own.
export const THIS_DEVICE_VIEW: DeviceStatusView = {
  tone: "emerald",
  label: "This device",
  reachable: true,
};

// The tooltip every compact mark for a device carries: its name and
// its state, in one spelling ("Thinkpad, Connected", "Studio Mac, This
// device"), so a pill, a tab and a badge naming the same machine say
// the same thing on hover.
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
