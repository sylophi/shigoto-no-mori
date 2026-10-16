// Whether this machine's host answers this window: false from its link
// dropping (the host stopped, or the shell's watchdog stopped a host
// that went silent) until a dial lands on the host that replaces it.
// Desktop only; a hostless client has no host of its own.
import type { HostRestartReason } from "@shigomori/ui/views/hostBand/HostBandView.tsx";
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import {
  type DeviceStatusView,
  THIS_DEVICE_NOT_RESPONDING_VIEW,
} from "@shigomori/ui/lib/deviceStatus.ts";

export const hostAnswering = createExternalStore(true);

// Why the shell last started the host again, published as the link
// lands on the new one (desktop.ts), for the band to say.
export const hostRestarted = createExternalStore<{
  readonly reason: HostRestartReason;
} | null>(null);

// This device's state where a surface tags it: none while its host
// answers (the glyph alone), and Not responding while it doesn't.
export function useThisDeviceStatus(): DeviceStatusView | null {
  return useExternalStore(hostAnswering)
    ? null
    : THIS_DEVICE_NOT_RESPONDING_VIEW;
}
