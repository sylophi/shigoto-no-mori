import type { ComponentType, ReactNode, SVGProps } from "react";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import { TONE_MARK, type Tone } from "../../primitives/status-dot.tsx";

interface StatusPillProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: Tone;
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
          TONE_MARK[tone],
        )}
      >
        <Icon aria-hidden className="size-3" />
        {children}
      </span>
    </SimpleTooltip>
  );
}
