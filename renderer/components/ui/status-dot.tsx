import type React from "react";
import { cn } from "@/lib/utils";

// The four raw families the doubutsu overlay remaps, plus slate for an
// off or neutral state. A new tone needs a matching remap entry in
// doubutsu.css, so the set stays closed here.
export type StatusTone = "emerald" | "rose" | "amber" | "sky" | "slate";

const TONE_BG: Record<StatusTone, string> = {
  emerald: "bg-emerald-500",
  rose: "bg-rose-500",
  amber: "bg-amber-500",
  sky: "bg-sky-500",
  // slate rides the theme's muted token so it tracks light and dark.
  slate: "bg-muted-foreground",
};

// The same tones as a tinted pill: background wash plus readable text,
// for the chips and badges that carry a status rather than dotting it
// (the registry row's status chip, the sidebar's device badges). Kept
// beside TONE_BG so a new tone can only be added in one place.
export const TONE_PILL: Record<StatusTone, string> = {
  emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  rose: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  sky: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  slate: "bg-muted text-muted-foreground",
};

// A tiny status indicator: a tinted dot with an optional inline label.
// Not interactive, so a plain span carries no data-slot. Shared by the
// hosting chip and the remote device status so the dot lives in one place.
export function StatusDot({
  tone,
  label,
}: {
  tone: StatusTone;
  label?: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={cn("size-1.5 rounded-full", TONE_BG[tone])} />
      {label}
    </span>
  );
}
