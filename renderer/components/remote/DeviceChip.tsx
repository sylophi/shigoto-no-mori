// The quiet "which machine is this" marker for device-scoped pages: a
// status dot and the device's name, rendered only under a remote host
// scope. The local pages stay chipless, since this machine is the default,
// not a state worth announcing.
import { StatusDot } from "@/components/ui/status-dot";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView } from "@/lib/remote/deviceStatus";

export function DeviceChip() {
  const { deviceId, remote } = useHostScope();
  const device = useRemoteDevice(deviceId);
  if (!remote || device === undefined) return null;
  const { tone, label } = deviceStatusView(device.status);
  return (
    <span
      data-slot="device-chip"
      // The name is the chip. The connection state stays on the dot's
      // tone and the tooltip, so the header reads "on Thinkpad", not a
      // status report.
      title={`${device.label} (${label})`}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground"
    >
      <StatusDot tone={tone} />
      <span className="max-w-32 truncate">{device.label}</span>
    </span>
  );
}
