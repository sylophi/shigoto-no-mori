import type { ComponentType, ReactNode, SVGProps } from "react";
import { cn } from "@/lib/utils";
import type { PullRequestTone } from "@/lib/pullRequest";

// Superset of PullRequestTone so the PR badge and sync-state badges
// share one pill primitive. Add new tones as new states show up.
export type PillTone = PullRequestTone | "amber" | "sky" | "indigo";

const TONE_CLASSES: Record<PillTone, string> = {
  emerald: "text-emerald-500",
  violet: "text-violet-500",
  rose: "text-rose-500",
  slate: "text-muted-foreground",
  amber: "text-amber-500",
  sky: "text-sky-500",
  indigo: "text-indigo-500",
};

interface StatusPillProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: PillTone;
  title: string;
  "aria-label": string;
  children?: ReactNode;
}

// Compact icon-and-optional-count badge. Numeric children get tabular
// figures so adjacent pills don't shift width as counts change.
export function StatusPill({
  icon: Icon,
  tone,
  title,
  "aria-label": ariaLabel,
  children,
}: StatusPillProps) {
  return (
    <span
      title={title}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex shrink-0 items-center text-[10px]",
        children != null && "tabular gap-0.5",
        TONE_CLASSES[tone],
      )}
    >
      <Icon aria-hidden className="size-3" />
      {children}
    </span>
  );
}
