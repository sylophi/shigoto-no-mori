// The device chip (DeviceChipView) for the page's host scope, rendered
// only under a remote one. The local pages stay chipless, since this
// machine is the default, not a state worth announcing.
import { DeviceChipView } from "@/components/shared/DeviceChipView";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView } from "@/lib/remote/deviceStatus";

export function DeviceChip() {
  const { deviceId, remote } = useHostScope();
  const device = useRemoteDevice(deviceId);
  if (!remote || device === undefined) return null;
  return (
    <DeviceChipView
      label={device.label}
      icon={device.icon}
      status={deviceStatusView(device.status)}
    />
  );
}
