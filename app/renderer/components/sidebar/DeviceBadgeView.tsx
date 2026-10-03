// The device badges' look (DeviceBadge.tsx gives them their data): the
// device's glyph on a tile in its connection tone (shared/DeviceGlyph.tsx
// DeviceMark), the same tile its row wears on the devices page, so a
// badge and a dot can never disagree about a machine, and the name
// rides the tooltip.
import { RefreshCw } from "lucide-react";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import { DeviceMark } from "@/components/shared/DeviceGlyph";
import type { StatusTone } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";

export interface SidebarDeviceBadge {
  deviceId: string;
  label: string;
  icon: DeviceIcon;
  tone: StatusTone;
  // Only for the tooltip's wording: an unreachable device's rows are
  // its last known state, which the tone alone doesn't say.
  reachable: boolean;
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

// The mark a local worktree wears for the peer it is mirrored with: the
// mirror glyph and the peer's badge, the badge only while the window
// shows device badges. Worn in the sidebar's rows and
// the palette's.
export function MirrorBadgeView({
  mirror,
  showBadge,
}: {
  mirror: SidebarDeviceBadge;
  showBadge: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <SimpleTooltip tip={`Mirrored with ${mirror.label}`}>
        <RefreshCw
          aria-label={`Mirrored with ${mirror.label}`}
          className="size-3 text-emerald-600 dark:text-emerald-400"
        />
      </SimpleTooltip>
      {showBadge && <DeviceBadge badge={mirror} />}
    </span>
  );
}

// The project-header cluster: one badge per contributing peer device,
// order preserved from the merge, while the window shows device badges
// (DeviceBadgeCluster reads that).
export function DeviceBadgeClusterView({
  devices,
  show,
}: {
  devices: readonly SidebarDeviceBadge[];
  show: boolean;
}) {
  if (!show || devices.length === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {devices.map((badge) => (
        <DeviceBadge key={badge.deviceId} badge={badge} />
      ))}
    </span>
  );
}
