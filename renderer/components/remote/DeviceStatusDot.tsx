import { StatusDot } from "@/components/ui/status-dot";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDeviceStatus } from "@/lib/remote/devices";

// The device's status phase as an inline status dot. deviceStatusView
// already reduces the phase to a tone drawn from the raw families the
// StatusDot primitive draws, so this only forwards the mapping.
export function DeviceStatusDot({ status }: { status: RemoteDeviceStatus }) {
  const { tone, label } = deviceStatusView(status);
  return <StatusDot tone={tone} label={label} />;
}
