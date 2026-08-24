import type { PillTone } from "@/components/sidebar/StatusPill";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { SupervisorStatus } from "@/lib/remote/supervisor";
import { cn } from "@/lib/utils";

// The inline status dot idiom from CliSection, tinted by the device's
// supervisor phase. Backgrounds stay within the four raw families the
// doubutsu overlay remaps (emerald, rose, amber, sky) plus slate for off.
const DOT_BG: Record<PillTone, string> = {
  emerald: "bg-emerald-500",
  rose: "bg-rose-500",
  amber: "bg-amber-500",
  sky: "bg-sky-500",
  slate: "bg-muted-foreground",
  violet: "bg-violet-500",
  indigo: "bg-indigo-500",
};

export function DeviceStatusDot({ status }: { status: SupervisorStatus }) {
  const { tone, label } = deviceStatusView(status);
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={cn("size-1.5 rounded-full", DOT_BG[tone])} />
      {label}
    </span>
  );
}
