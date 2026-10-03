// Compact device attribution for the merged tree, with the data the
// badges need (their look is DeviceBadgeView.tsx): one mark per
// contributing device on project headers, and the single-mark form on
// remote worktree rows.
import {
  DeviceBadge,
  DeviceBadgeClusterView,
  MirrorBadgeView,
  type SidebarDeviceBadge,
} from "./DeviceBadgeView";
import { useShowDeviceBadges } from "@/hooks/config/useSidebarMarks";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView } from "@/lib/remote/deviceStatus";

export { DeviceBadge, type SidebarDeviceBadge };

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

// The mark a local worktree wears for the peer it is mirrored with
// (MirrorBadgeView), its badge shown while this window has Show device
// icons on (Settings, Appearance).
export function MirrorBadge({ mirror }: { mirror: SidebarDeviceBadge }) {
  const show = useShowDeviceBadges();
  return <MirrorBadgeView mirror={mirror} showBadge={show} />;
}

// The project-header cluster: one badge per contributing peer device,
// order preserved from the merge. Gated like MirrorBadge's.
export function DeviceBadgeCluster({
  devices,
}: {
  devices: readonly SidebarDeviceBadge[];
}) {
  return (
    <DeviceBadgeClusterView devices={devices} show={useShowDeviceBadges()} />
  );
}
