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
    // established (data is direct or nothing).
    // Honest on both axes: the roster fact shows ("Online"), and
    // nothing claims a data connection, because the keeper's eager
    // dial has not landed yet (it dials on presence and redials
    // forever, so success flips this to "Connected" on its own).
    case "online":
      return { tone: "sky", label: "Online" };
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

export function deviceStatusView(status: RemoteDeviceStatus): DeviceStatusView {
  return {
    ...presentationOf(status),
    // "online" is reachable because the keeper is already dialing or
    // redialing the session a use would ride.
    reachable: status.phase === "connected" || status.phase === "online",
  };
}
