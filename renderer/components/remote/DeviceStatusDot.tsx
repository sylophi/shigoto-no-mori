import type { SupervisorStatus } from "@shared/remote/supervisor";
import { StatusDot } from "@/components/ui/status-dot";
import { deviceStatusView } from "@/lib/remote/deviceStatus";

// The device's supervisor phase as an inline status dot. deviceStatusView
// already reduces the phase to a tone drawn from the raw families the
// StatusDot primitive draws, so this only forwards the mapping.
export function DeviceStatusDot({ status }: { status: SupervisorStatus }) {
  const { tone, label } = deviceStatusView(status);
  return <StatusDot tone={tone} label={label} />;
}
