// Compact device attribution for the merged tree: one mark per
// contributing device on project headers, and the single-mark form on
// remote worktree rows. The mark is the device's glyph on a tile in
// its connection tone (shared/DeviceGlyphView.tsx DeviceMarkView), the same
// tile its row wears on the account page, so a badge and a dot can
// never disagree about a machine, and the name rides the tooltip.
import { RefreshCw } from "lucide-react";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import { DeviceMarkView } from "@shigomori/ui/views/shared/DeviceGlyphView.tsx";
import type { StatusTone } from "@shigomori/ui/primitives/status-dot.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";

export interface SidebarDeviceBadge {
  deviceId: string;
  label: string;
  icon: DeviceIcon;
  tone: StatusTone;
  // Only for the tooltip's wording: an unreachable device's rows are
  // its last known state, which the tone alone doesn't say.
  reachable: boolean;
}

export function DeviceBadgeView({ badge }: { badge: SidebarDeviceBadge }) {
  return (
    <SimpleTooltip
      tip={`${badge.label}${badge.reachable ? "" : " (not reachable right now, last known state)"}`}
    >
      <span className="inline-flex shrink-0" aria-label={`On ${badge.label}`}>
        <DeviceMarkView icon={badge.icon} tone={badge.tone} />
      </span>
    </SimpleTooltip>
  );
}

// The mark a local worktree wears for the peer it is mirrored with: the
// mirror glyph and the peer's badge, while this window has Show device
// icons on (Settings, Appearance, useShowDeviceBadges). Worn in the
// sidebar's rows and the palette's.
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
      {showBadge && <DeviceBadgeView badge={mirror} />}
    </span>
  );
}

// The project-header cluster: one badge per contributing peer device,
// order preserved from the merge. A sidebar row draws its badges only
// while this window has Show device icons on (useShowDeviceBadges).
// The palette and the inbox's create target draw them bare, since
// there the device is the choice being made rather than a decoration.
export function DeviceBadgeClusterView({
  devices,
}: {
  devices: readonly SidebarDeviceBadge[];
}) {
  if (devices.length === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {devices.map((badge) => (
        <DeviceBadgeView key={badge.deviceId} badge={badge} />
      ))}
    </span>
  );
}
