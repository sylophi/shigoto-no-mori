// A device's icon, picked in place: the mark on its Devices page row
// is the trigger, and the menu lays out every icon the catalog has
// (shared/account/deviceIcon.ts) as one grid of tiles: the device
// shapes as the first row, with what the device detected about itself
// named as such, then under a hairline the marks that are only ever
// picked (a leaf, a cat, a rocket), which tell two laptops apart the
// way a shape never can. No headings: the tiles say what they are.
// Picking the detected shape drops the pick (the store's rule: no pick
// means "what I detected"), so a device put back to its default carries
// no override that a later, better detection could not move. The pick
// is made on the device hub, so any row offers it, a peer's included,
// online or not: every device sees the new mark on its next registry
// read, the picked one too (shared/account/enroll.ts).
// DeviceIconPickerView draws it.
import type { DeviceIcon } from "@shared/account/deviceIcon";
import type { StatusTone } from "@/components/ui/status-dot";
import { useAccountStatus, useSetDeviceIcon } from "@/hooks/account/useAccount";
import { DeviceIconPickerView } from "./DeviceIconPickerView";

export function DeviceIconPicker({
  deviceId,
  isThisDevice,
  icon,
  tone,
  // "This device" for this one, the peer's name otherwise, for the
  // control's accessible name.
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
  // What this device detected about itself, for the tile that means
  // "back to the default": the icon worn now until the status lands,
  // moments before the picker re-renders with the real answer. A peer
  // reports no detection to the hub, so its tiles name none.
  const detected = isThisDevice
    ? (status?.detectedDeviceIcon ?? icon)
    : undefined;
  const onPick = (next: DeviceIcon) => {
    if (next !== icon) setDeviceIcon.mutate({ deviceId, icon: next });
  };
  return (
    <DeviceIconPickerView
      icon={icon}
      tone={tone}
      label={label}
      detected={detected}
      disabled={setDeviceIcon.isPending}
      onPick={onPick}
    />
  );
}
