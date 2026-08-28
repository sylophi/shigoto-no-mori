// Presentation mapping for a remote device's status (v2 step 3, slice
// C). One place turns the phase into a tone and a label so the
// settings chip and the forest page read the same. Tones stay within
// the four raw families the theme remaps (emerald, rose, amber, sky)
// plus slate for off, per the doubutsu contract.
import type { StatusTone } from "@/components/ui/status-dot";
import type { RemoteDeviceStatus } from "./devices";

export type DeviceStatusView = {
  // Exactly the closed tone set the StatusDot primitive draws, so every
  // phase maps to a renderable dot by construction.
  tone: StatusTone;
  label: string;
  // True only when a DIRECT data session to the device is established,
  // so a caller can gate live-connection affordances (settings
  // read/write, push subscriptions) on a real wire.
  connected: boolean;
  // True when using the device's api can work right now: a direct
  // session is up ("connected"), or the peer is in the relay roster
  // and a use would dial one ("online"). The ONE vocabulary for
  // reach-gated affordances (showing a forest, offering the View
  // forest link), so components stop each spelling the same predicate
  // their own way.
  reachable: boolean;
};

// The presentation half: phase to tone and label. The two booleans are
// derived once below, never per arm, so a new phase cannot ship an
// inconsistent connected/reachable pair.
function presentationOf(status: RemoteDeviceStatus): {
  tone: StatusTone;
  label: string;
} {
  switch (status.phase) {
    case "connected":
      return { tone: "emerald", label: "Connected" };
    // The peer is in the relay roster but no direct session is
    // established (v2 step 10, slice C: data is direct or nothing).
    // Honest on both axes: the roster fact shows ("Online"), and
    // nothing claims a data connection, because none exists yet or the
    // dial failed. Using the session opens it, and success flips this
    // to "Connected".
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
    connected: status.phase === "connected",
    // "online" is reachable because using the api is exactly what
    // dials a direct session.
    reachable: status.phase === "connected" || status.phase === "online",
  };
}
