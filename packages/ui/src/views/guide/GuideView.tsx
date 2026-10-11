// The guide in a window it drives: a band over the page saying whose
// agent it is, with Stop, and a ring around what the agent points at with
// its sentence beside it (GuideBand.tsx and GuideCallout.tsx bind them).
import { Compass } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { TONE_MARK, TONE_PILL } from "../../primitives/status-dot.tsx";
import { cn, dragRegion } from "../../lib/utils.ts";

export function GuideBandView({
  harnessLabel,
  onStop,
}: {
  harnessLabel: string;
  onStop: () => void;
}) {
  return (
    // At the top of the window, so the title bar drags by it.
    <div
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 px-4 text-xs",
        TONE_PILL.sky,
      )}
      style={dragRegion("drag")}
    >
      <Compass aria-hidden className={cn("size-3.5", TONE_MARK.sky)} />
      <span className="min-w-0 flex-1 truncate">
        {harnessLabel} is showing you around
      </span>
      <Button
        size="xs"
        variant="ghost"
        style={dragRegion("no-drag")}
        onClick={onStop}
      >
        Stop
      </Button>
    </div>
  );
}

// Where the target is, from the window's corner, and where its sentence
// goes: under it, or over it when there is more room above. The view is
// laid over the whole window (AppShellView's overlays).
export interface GuideCalloutPlace {
  ring: { x: number; y: number; width: number; height: number };
  left: number;
  top?: number;
  bottom?: number;
}

// The gap between a target and its ring, and between the ring and the
// sentence.
const RING_GAP = 4;

export function GuideCalloutView({
  place,
  say,
}: {
  place: GuideCalloutPlace;
  say: string;
}) {
  const { ring } = place;
  return (
    // Over the menus and dialogs (z-50), which the guide points into.
    <div className="pointer-events-none absolute inset-0 z-[60]">
      <div
        data-slot="guide-ring"
        className="absolute rounded-lg ring-2 ring-sky-500 transition-all duration-150 motion-reduce:transition-none"
        style={{
          left: ring.x - RING_GAP,
          top: ring.y - RING_GAP,
          width: ring.width + RING_GAP * 2,
          height: ring.height + RING_GAP * 2,
        }}
      />
      <div
        role="status"
        data-slot="guide-callout-box"
        className="absolute w-max max-w-72 rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
        style={{ left: place.left, top: place.top, bottom: place.bottom }}
      >
        {say}
      </div>
    </div>
  );
}
