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

// The same tones as plain text, for a status word set inline in a
// metadata line (the status word opening a row on the devices page),
// where a pill would be one box too many. Kept beside TONE_BG so a new
// tone can only be added in one place.
export const TONE_TEXT: Record<StatusTone, string> = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  rose: "text-rose-600 dark:text-rose-400",
  amber: "text-amber-600 dark:text-amber-400",
  sky: "text-sky-600 dark:text-sky-400",
  slate: "text-muted-foreground",
};

// The same tones as a tinted pill: the text above over a background
// wash, for the badges that carry a status rather than dotting it (the
// sidebar's device badges, the devices page's device mark). Composed
// from TONE_TEXT so the two can never disagree.
export const TONE_PILL: Record<StatusTone, string> = {
  emerald: `bg-emerald-500/10 ${TONE_TEXT.emerald}`,
  rose: `bg-rose-500/10 ${TONE_TEXT.rose}`,
  amber: `bg-amber-500/10 ${TONE_TEXT.amber}`,
  sky: `bg-sky-500/10 ${TONE_TEXT.sky}`,
  slate: `bg-muted ${TONE_TEXT.slate}`,
};

// A tiny status indicator: a tinted dot with an optional inline label.
// Not interactive, so a plain span carries no data-slot. Shared by the
// hosting chip and the remote device status so the dot lives in one place.
export function StatusDot({
  tone,
  label,
  pulse = false,
  className,
}: {
  tone: StatusTone;
  label?: React.ReactNode;
  // A soft breathing halo in the dot's own tone, for a state that is
  // live right now (a server answering on a port) rather than merely
  // recorded.
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      <span className="relative flex size-1.5 shrink-0">
        {pulse && (
          <span
            className={cn(
              "absolute -inset-1 animate-pulse rounded-full opacity-25",
              TONE_BG[tone],
            )}
          />
        )}
        <span className={cn("relative size-1.5 rounded-full", TONE_BG[tone])} />
      </span>
      {label}
    </span>
  );
}
