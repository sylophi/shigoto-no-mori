// Presentation mapping for a remote device's supervisor status (v2 step
// 3, slice C). One place turns the state machine phase into a tone and a
// label so the settings chip and the forest page read the same. Tones
// stay within the four raw families the theme remaps (emerald, rose,
// amber, sky) plus slate for off, per the doubutsu contract.
import type { SupervisorStatus } from "@shared/remote/supervisor";
import type { PillTone } from "@/components/sidebar/StatusPill";

// The tones this view actually emits, a subset of PillTone. Named so the
// status dot maps over exactly these and carries no unreachable branch
// for a tone the state machine can never produce.
export type DeviceTone = Extract<
  PillTone,
  "emerald" | "sky" | "amber" | "rose" | "slate"
>;

export type DeviceStatusView = {
  tone: DeviceTone;
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
