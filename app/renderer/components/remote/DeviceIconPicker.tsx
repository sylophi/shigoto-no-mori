import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import type { StatusTone } from "@shigomori/ui/primitives/status-dot.tsx";
import { useAccountStatus, useSetDeviceIcon } from "@/hooks/account/useAccount";
import { DeviceIconPickerView } from "./DeviceIconPickerView";

// A device's icon picker (DeviceIconPickerView), its pick written to
// the device hub.
export function DeviceIconPicker({
  deviceId,
  isThisDevice,
  icon,
  tone,
  label,
}: {
  deviceId: string;
  isThisDevice: boolean;
  icon: DeviceIcon;
  tone: StatusTone;
  label: string;
}) {
  const setDeviceIcon = useSetDeviceIcon();
  const status = useAccountStatus().data;
  return (
    <DeviceIconPickerView
      icon={icon}
      tone={tone}
      label={label}
      // The icon worn now until the status lands, moments before the
      // picker re-renders with the real answer.
      detected={isThisDevice ? (status?.detectedDeviceIcon ?? icon) : undefined}
      disabled={setDeviceIcon.isPending}
      onPick={(next) => {
        if (next !== icon) setDeviceIcon.mutate({ deviceId, icon: next });
      }}
    />
  );
}
