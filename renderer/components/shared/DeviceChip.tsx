// The quiet "which machine is this" marker for device-scoped pages: the
// device's connection dot, its glyph and its name, rendered only under
// a remote host scope. The local pages stay chipless, since this machine is the default,
// not a state worth announcing.
import { DeviceGlyph } from "@/components/shared/DeviceIcon";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView, deviceTitle } from "@/lib/remote/deviceStatus";

// The pill shape, shared with the device tabs (shared/DeviceTabs.tsx):
// one string, so a chip and a tab naming the same machine are the
// same pill, and doubutsu's fill lands on both through the data-slot.
export const DEVICE_PILL_CLASS =
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground";

export function DeviceChip() {
  const { deviceId, remote } = useHostScope();
  const device = useRemoteDevice(deviceId);
  if (!remote || device === undefined) return null;
  const status = deviceStatusView(device.status);
  return (
    <span
      data-slot="device-chip"
      // The name is the chip. The connection state stays on the dot's
      // tone and the tooltip, so the header reads "on Thinkpad", not a
      // status report.
      title={deviceTitle(device.label, status)}
      className={DEVICE_PILL_CLASS}
    >
      <DeviceGlyph kind={device.kind} tone={status.tone} />
      <span className="max-w-32 truncate">{device.label}</span>
    </span>
  );
}
