// Compact device attribution for the merged tree: a two-letter badge
// per contributing device on project headers, and the single-badge form
// on remote worktree rows. Tone is the device's connection tone
// (deviceStatusView), the same one its dot carries on the devices page,
// drawn through the shared TONE_PILL table so a badge and a dot can
// never disagree about a machine.
import { TONE_PILL, type StatusTone } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SidebarDeviceBadge {
  deviceId: string;
  label: string;
  tone: StatusTone;
  // Only for the tooltip's wording: an unreachable device's rows are
  // its last known state, which the tone alone doesn't say.
  reachable: boolean;
}

// "Studio Mac" -> SM, "Thinkpad" -> TH, "Work PC" -> WP. Word initials
// when there are two words, else the first two letters. Enough to tell
// an account's handful of machines apart, with the full name on hover.
export function deviceAbbrev(label: string): string {
  const words = label.trim().split(/\s+/);
  const first = words[0] ?? "";
  const second = words[1];
  const abbrev =
    second !== undefined && second.length > 0
      ? `${first[0] ?? ""}${second[0] ?? ""}`
      : first.slice(0, 2);
  return abbrev.toUpperCase();
}

export function DeviceBadge({ badge }: { badge: SidebarDeviceBadge }) {
  return (
    <SimpleTooltip
      tip={`${badge.label}${badge.reachable ? "" : " (offline, last known state)"}`}
    >
      <span
        className={cn(
          "inline-flex shrink-0 items-center rounded px-1 py-px font-mono text-[9px] font-semibold tracking-wide",
          TONE_PILL[badge.tone],
        )}
        aria-label={`On ${badge.label}`}
      >
        {deviceAbbrev(badge.label)}
      </span>
    </SimpleTooltip>
  );
}

// The project-header cluster: one badge per contributing peer device,
// order preserved from the merge.
export function DeviceBadgeCluster({
  devices,
}: {
  devices: readonly SidebarDeviceBadge[];
}) {
  if (devices.length === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {devices.map((badge) => (
        <DeviceBadge key={badge.deviceId} badge={badge} />
      ))}
    </span>
  );
}
