import { ChevronDown } from "lucide-react";
import { cn } from "../lib/utils.ts";

// A long text cut down to a few lines fades out at the cut.
export const FOLD_FADE =
  "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]";

// The toggle under a long text cut down to a few lines.
export function ShowMoreButton({
  expanded,
  onToggle,
  className,
}: {
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      data-slot="show-more"
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      {expanded ? "Show less" : "Show more"}
      <ChevronDown
        aria-hidden
        className={cn("size-3.5 opacity-60", expanded && "rotate-180")}
      />
    </button>
  );
}
