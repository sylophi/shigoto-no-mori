// The quiet "which machine is this" marker for device-scoped pages: the
// device's connection dot, its glyph and its name. DeviceChip draws it
// only under a remote host scope.
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import { DeviceLeadView } from "./DeviceGlyphView.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { deviceTitle, type DeviceStatusView } from "../../lib/deviceStatus.ts";

// The pill shape, shared with the device tabs (DeviceTabBarView): one
// string, so a chip and a tab naming the same machine are the same
// pill, and doubutsu's fill lands on both through the data-slot.
export const DEVICE_PILL_CLASS =
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground";

export function DeviceChipView({
  label,
  icon,
  status,
}: {
  label: string;
  icon: DeviceIcon;
  status: DeviceStatusView;
}) {
  return (
    // The name is the chip. The connection state stays on the dot's
    // tone and the tooltip, so the header reads "on Thinkpad", not a
    // status report.
    <SimpleTooltip tip={deviceTitle(label, status)}>
      <span data-slot="device-chip" className={DEVICE_PILL_CLASS}>
        <DeviceLeadView icon={icon} tone={status.tone} />
        <span className="max-w-32 truncate">{label}</span>
      </span>
    </SimpleTooltip>
  );
}
