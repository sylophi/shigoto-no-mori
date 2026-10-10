// The device badges the sidebar's rows wear (DeviceBadgeView), off the
// device registry.
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView } from "@shigomori/ui/lib/deviceStatus.ts";
import type { SidebarDeviceBadge } from "@shigomori/ui/views/sidebar/DeviceBadgeView.tsx";

// Every peer on the account as a badge, by device id: the lookup behind
// a badge that names a device by id alone (a local row's mirror). Off
// the device registry rather than off whichever peers' rows happen to
// be on screen, so it holds whatever the sidebar's device filter hides.
export function useDeviceBadges(): ReadonlyMap<string, SidebarDeviceBadge> {
  const devices = useRemoteDevices();
  const badges = new Map<string, SidebarDeviceBadge>();
  for (const device of devices) {
    const { tone, reachable } = deviceStatusView(device.status);
    badges.set(device.deviceId, {
      deviceId: device.deviceId,
      label: device.label,
      icon: device.icon,
      tone,
      reachable,
    });
  }
  return badges;
}
