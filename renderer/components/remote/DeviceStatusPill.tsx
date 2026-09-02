import {
  StatusDot,
  type StatusTone,
  TONE_PILL,
} from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

// A device's state as a tinted pill: the Devices page's registry rows
// and the Settings header beside a device's name draw the same one, so
// a machine reads the same in both places.
export function DeviceStatusPill({
  tone,
  label,
}: {
  tone: StatusTone;
  label: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 align-middle",
        TONE_PILL[tone],
      )}
    >
      <StatusDot tone={tone} label={<span className="text-xs">{label}</span>} />
    </span>
  );
}
