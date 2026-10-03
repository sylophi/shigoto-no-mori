// The device chip as drawn (DeviceChip.tsx looks the device up): the
// device's connection dot, its glyph and its name.
import type { DeviceIcon } from "@shared/account/deviceIcon";
import { DeviceLead } from "@/components/shared/DeviceGlyph";
import type { StatusTone } from "@/components/ui/status-dot";

// The pill shape, shared with the device tabs (shared/DeviceTabs.tsx):
// one string, so a chip and a tab naming the same machine are the
// same pill, and doubutsu's fill lands on both through the data-slot.
export const DEVICE_PILL_CLASS =
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground";

export interface DeviceChipLook {
  label: string;
  icon: DeviceIcon;
  tone: StatusTone;
  // The tooltip, which carries the connection state (deviceTitle).
  title: string;
}

export function DeviceChipView({ label, icon, tone, title }: DeviceChipLook) {
  return (
    <span
      data-slot="device-chip"
      // The name is the chip. The connection state stays on the dot's
      // tone and the tooltip, so the header reads "on Thinkpad", not a
      // status report.
      title={title}
      className={DEVICE_PILL_CLASS}
    >
      <DeviceLead icon={icon} tone={tone} />
      <span className="max-w-32 truncate">{label}</span>
    </span>
  );
}
