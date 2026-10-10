import type React from "react";
import { SimpleTooltip, type WithoutTitle } from "./tooltip.tsx";
import { cn } from "../lib/utils.ts";

// The app's one tone table. A tone is a raw color family doubutsu.css
// remaps (emerald, rose, amber, sky, and violet and indigo for a pull
// request's and a sync's states), or slate, an off or neutral state on
// the theme's muted tokens. A new tone needs its remap in doubutsu.css
// and a row in each table below, so the set stays closed here.
export type Tone =
  | "emerald"
  | "rose"
  | "amber"
  | "sky"
  | "violet"
  | "indigo"
  | "slate";

// The tones a status dot, a status word and a status pill take.
export type StatusTone = Exclude<Tone, "violet" | "indigo">;

const TONE_BG: Record<StatusTone, string> = {
  emerald: "bg-emerald-500",
  rose: "bg-rose-500",
  amber: "bg-amber-500",
  sky: "bg-sky-500",
  // slate rides the theme's muted token so it tracks light and dark.
  slate: "bg-muted-foreground",
};

// A status word set inline in a metadata line (the status word opening
// a row on the account page), where a pill would be one box too many:
// a step darker than a mark in light and lighter in dark, so text
// reads.
export const TONE_TEXT: Record<StatusTone, string> = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  rose: "text-rose-600 dark:text-rose-400",
  amber: "text-amber-600 dark:text-amber-400",
  sky: "text-sky-600 dark:text-sky-400",
  slate: "text-muted-foreground",
};

// A mark in its tone: an icon, or the icon and count of a compact
// status (a pull request's state and checks, a sync pill).
export const TONE_MARK: Record<Tone, string> = {
  emerald: "text-emerald-500",
  rose: "text-rose-500",
  amber: "text-amber-500",
  sky: "text-sky-500",
  violet: "text-violet-500",
  indigo: "text-indigo-500",
  slate: "text-muted-foreground",
};

// The wash behind a tone, for a pill.
export const TONE_FILL: Record<Tone, string> = {
  emerald: "bg-emerald-500/10",
  rose: "bg-rose-500/10",
  amber: "bg-amber-500/10",
  sky: "bg-sky-500/10",
  violet: "bg-violet-500/10",
  indigo: "bg-indigo-500/10",
  slate: "bg-muted",
};

// A status word on its wash, for the badges that carry a status rather
// than dotting it (the sidebar's device badges, the account page's
// device mark, a Tidy verdict).
export const TONE_PILL: Record<StatusTone, string> = {
  emerald: `${TONE_FILL.emerald} ${TONE_TEXT.emerald}`,
  rose: `${TONE_FILL.rose} ${TONE_TEXT.rose}`,
  amber: `${TONE_FILL.amber} ${TONE_TEXT.amber}`,
  sky: `${TONE_FILL.sky} ${TONE_TEXT.sky}`,
  slate: `${TONE_FILL.slate} ${TONE_TEXT.slate}`,
};

// A tiny status indicator: a tinted dot with an optional inline label.
// Not interactive, so a plain span carries no data-slot. Shared by the
// hosting chip and the remote device status so the dot lives in one place.
// The rest of the props land on the root span, so a SimpleTooltip can
// wrap the dot directly.
export function StatusDot({
  tone,
  label,
  pulse = false,
  className,
  ...props
}: WithoutTitle<React.ComponentProps<"span">> & {
  tone: StatusTone;
  label?: React.ReactNode;
  // A soft breathing halo in the dot's own tone, for a state that is
  // live right now (a server answering on a port) rather than merely
  // recorded.
  pulse?: boolean;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-sm", className)}
      {...props}
    >
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

// The mark for an update this window could install: the sidebar's
// Settings dot, carried onto the Settings row and the device tab that
// hold it, so the dot that brought the visitor there points at what it
// meant.
// `version` names the release where the mark stands for one device.
export function UpdateMark({
  version,
  className,
}: {
  version?: string;
  className?: string;
}) {
  const label =
    version === undefined
      ? "Update available"
      : `Update to v${version} available`;
  // A bare dot doesn't say what it marks, so it says it on hover.
  return (
    <SimpleTooltip tip={label}>
      <StatusDot
        tone="sky"
        className={className}
        label={<span className="sr-only">{label}</span>}
      />
    </SimpleTooltip>
  );
}
