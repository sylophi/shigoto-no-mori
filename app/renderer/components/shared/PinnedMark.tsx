import { Pin } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";

// The pin after a pinned project's name, in the sidebar and on the
// home page's tiles.
export function PinnedMark() {
  return (
    <SimpleTooltip tip="Pinned">
      <span className="inline-flex shrink-0">
        <Pin
          aria-label="Pinned"
          // Tilted the way a pushpin sits, and down a pixel to the
          // lowercase name it follows rather than the line's middle.
          className="size-2.5 translate-y-px rotate-45 text-muted-foreground/70"
        />
      </span>
    </SimpleTooltip>
  );
}
