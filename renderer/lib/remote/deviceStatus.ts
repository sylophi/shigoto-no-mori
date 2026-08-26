// Presentation mapping for a remote device's supervisor status (v2 step
// 3, slice C). One place turns the state machine phase into a tone and a
// label so the settings chip and the forest page read the same. Tones
// stay within the four raw families the theme remaps (emerald, rose,
// amber, sky) plus slate for off, per the doubutsu contract.
import type { SupervisorStatus } from "@shared/remote/supervisor";
import type { StatusTone } from "@/components/ui/status-dot";

export type DeviceStatusView = {
  // Exactly the closed tone set the StatusDot primitive draws, so every
  // phase maps to a renderable dot by construction.
  tone: StatusTone;
  label: string;
  // True only when the socket handshake has completed, so a caller can
  // gate a "View forest" affordance on a real connection.
  connected: boolean;
};

export function deviceStatusView(status: SupervisorStatus): DeviceStatusView {
  switch (status.phase) {
    case "connected":
      return { tone: "emerald", label: "Connected", connected: true };
    case "connecting":
    case "idle":
      return { tone: "sky", label: "Connecting", connected: false };
    case "backoff":
      return { tone: "amber", label: "Reconnecting", connected: false };
    case "blocked":
      return { tone: "rose", label: "Blocked", connected: false };
    case "stopped":
      return { tone: "slate", label: "Off", connected: false };
  }
}
