// The quiet "which machine is this" marker for device-scoped pages: the
// device's connection dot, its glyph and its name, rendered only under
// a remote host scope. The local pages stay chipless, since this machine is the default,
// not a state worth announcing. Drawn by DeviceChipView.
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView, deviceTitle } from "@/lib/remote/deviceStatus";
import { DeviceChipView } from "./DeviceChipView";

export function DeviceChip() {
  const { deviceId, remote } = useHostScope();
  const device = useRemoteDevice(deviceId);
  if (!remote || device === undefined) return null;
  const status = deviceStatusView(device.status);
  return (
    <DeviceChipView
      label={device.label}
      icon={device.icon}
      tone={status.tone}
      title={deviceTitle(device.label, status)}
    />
  );
}
