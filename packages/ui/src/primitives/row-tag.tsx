import type React from "react";
import { cn } from "../lib/utils.ts";
import { type StatusTone, TONE_PILL } from "./status-dot.tsx";
import type { WithoutTitle } from "./tooltip.tsx";

// Neutral marker for a property of the thing a row names ("External",
// "Shelved", "This device"): small caps in the muted family, so it
// reads as a label on the row rather than as a status the row is in.
export function RowTag({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-3xs font-medium tracking-wide text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

// A status a row is in ("missing", "3 uncommitted", "Read-only"): an
// optional icon and a word on its tone's wash. The rest of the props
// land on the span, so a SimpleTooltip can wrap it.
export function ToneTag({
  tone,
  className,
  ...props
}: WithoutTitle<React.ComponentProps<"span">> & { tone?: StatusTone }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-3xs font-medium",
        tone && TONE_PILL[tone],
        className,
      )}
      {...props}
    />
  );
}
