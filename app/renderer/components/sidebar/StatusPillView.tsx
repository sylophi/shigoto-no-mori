import type { ComponentType, ReactNode, SVGProps } from "react";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import type { PullRequestTone } from "@shigomori/ui/lib/pullRequest.ts";

// Superset of PullRequestTone so the PR badge and sync-state badges
// share one pill primitive. Add new tones as new states show up.
type PillTone = PullRequestTone | "amber" | "sky" | "indigo";

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
  tip: string;
  "aria-label": string;
  children?: ReactNode;
}

// Compact icon-and-optional-count badge. Numeric children get tabular
// figures so adjacent pills don't shift width as counts change.
export function StatusPillView({
  icon: Icon,
  tone,
  tip,
  "aria-label": ariaLabel,
  children,
}: StatusPillProps) {
  return (
    <SimpleTooltip tip={tip}>
      <span
        aria-label={ariaLabel}
        className={cn(
          "inline-flex shrink-0 items-center text-3xs",
          children != null && "tabular gap-0.5",
          TONE_CLASSES[tone],
        )}
      >
        <Icon aria-hidden className="size-3" />
        {children}
      </span>
    </SimpleTooltip>
  );
}
