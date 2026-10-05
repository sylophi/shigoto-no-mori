// Compact device attribution for the merged tree: one mark per
// contributing device on project headers, and the single-mark form on
// remote worktree rows. The mark is the device's glyph on a tile in
// its connection tone (shared/DeviceGlyph.tsx DeviceMark), the same
// tile its row wears on the account page, so a badge and a dot can
// never disagree about a machine, and the name rides the tooltip.
import { RefreshCw } from "lucide-react";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import { DeviceMark } from "@/components/shared/DeviceGlyph";
import type { StatusTone } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useShowDeviceBadges } from "@/hooks/config/useSidebarMarks";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView } from "@/lib/remote/deviceStatus";

export interface SidebarDeviceBadge {
  deviceId: string;
  label: string;
  icon: DeviceIcon;
  tone: StatusTone;
  // Only for the tooltip's wording: an unreachable device's rows are
  // its last known state, which the tone alone doesn't say.
  reachable: boolean;
}

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

export function DeviceBadge({ badge }: { badge: SidebarDeviceBadge }) {
  return (
    <SimpleTooltip
      tip={`${badge.label}${badge.reachable ? "" : " (not reachable right now, last known state)"}`}
    >
      <span className="inline-flex shrink-0" aria-label={`On ${badge.label}`}>
        <DeviceMark icon={badge.icon} tone={badge.tone} />
      </span>
    </SimpleTooltip>
  );
}

// A sidebar row's badge: the same badge, while this window has Show
// device icons on (Settings, Appearance). The palette and the inbox's
// create target draw DeviceBadge bare, since there the device is the
// choice being made rather than a decoration.
export function RowDeviceBadge({ badge }: { badge: SidebarDeviceBadge }) {
  const show = useShowDeviceBadges();
  return show ? <DeviceBadge badge={badge} /> : null;
}

// The mark a local worktree wears for the peer it is mirrored with: the
// mirror glyph and the peer's badge. Worn in the sidebar's rows and the
// palette's.
export function MirrorBadge({ mirror }: { mirror: SidebarDeviceBadge }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <SimpleTooltip tip={`Mirrored with ${mirror.label}`}>
        <RefreshCw
          aria-label={`Mirrored with ${mirror.label}`}
          className="size-3 text-emerald-600 dark:text-emerald-400"
        />
      </SimpleTooltip>
      <RowDeviceBadge badge={mirror} />
    </span>
  );
}

// The project-header cluster: one badge per contributing peer device,
// order preserved from the merge. Gated like RowDeviceBadge.
export function DeviceBadgeCluster({
  devices,
}: {
  devices: readonly SidebarDeviceBadge[];
}) {
  const show = useShowDeviceBadges();
  if (!show || devices.length === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {devices.map((badge) => (
        <DeviceBadge key={badge.deviceId} badge={badge} />
      ))}
    </span>
  );
}
