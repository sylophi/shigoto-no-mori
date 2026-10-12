// The guide in a window it drives: a band over the page saying whose
// agent it is, with Stop, and a ring around what the agent points at with
// its sentence beside it (GuideBand.tsx and GuideCallout.tsx bind them).
import { Compass, Square } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { TONE_FILL, TONE_MARK } from "../../primitives/status-dot.tsx";
import { cn, dragRegion } from "../../lib/utils.ts";

export function GuideBandView({
  harnessLabel,
  onStop,
}: {
  harnessLabel: string;
  onStop: () => void;
}) {
  return (
    // At the top of the window, so the title bar drags by it. Its wash
    // sits on the page's background, not the window's canvas.
    <div className="shrink-0 bg-background" style={dragRegion("drag")}>
      <div
        className={cn(
          "flex h-9 items-center gap-2 px-4 text-xs text-muted-foreground",
          TONE_FILL.sky,
        )}
      >
        <Compass
          aria-hidden
          className={cn("size-3.5 shrink-0", TONE_MARK.sky)}
        />
        <p className="min-w-0 flex-1 truncate">
          <span className="font-semibold text-foreground">{harnessLabel}</span>{" "}
          is showing you around
        </p>
        <Button
          size="xs"
          variant="outline"
          style={dragRegion("no-drag")}
          onClick={onStop}
        >
          <Square aria-hidden className="size-2.5 fill-current" />
          Stop
        </Button>
      </div>
    </div>
  );
}

// Where the target is, from the window's corner, its corner's radius,
// and where its sentence goes: under it, or over it when there is more
// room above. The view is laid over the whole window (AppShellView's
// overlays).
export interface GuideCalloutPlace {
  ring: { x: number; y: number; width: number; height: number };
  // The target's own (its computed border-radius), so the ring follows
  // a pill as it does a card.
  radius: string;
  left: number;
  top?: number;
  bottom?: number;
}

// The gap between a target and its ring, and how far in from the
// sentence's corners its tail stays.
const RING_GAP = 4;
const TAIL_INSET = 16;

export function GuideCalloutView({
  place,
  say,
}: {
  place: GuideCalloutPlace;
  say: string;
}) {
  const { ring } = place;
  const below = place.top !== undefined;
  // The tail under the target's middle, as far as the sentence reaches.
  const tail = Math.max(TAIL_INSET, ring.x + ring.width / 2 - place.left);
  return (
    // Over the menus and dialogs (z-50), which the guide points into.
    <div className="pointer-events-none absolute inset-0 z-[60]">
      <div
        data-slot="guide-ring"
        className="absolute shadow-[0_0_0_6px_color-mix(in_oklab,var(--color-sky-500)_20%,transparent)] ring-2 ring-sky-500 transition-all duration-150 motion-reduce:transition-none"
        style={{
          left: ring.x - RING_GAP,
          top: ring.y - RING_GAP,
          width: ring.width + RING_GAP * 2,
          height: ring.height + RING_GAP * 2,
          borderRadius: `calc(${place.radius} + ${RING_GAP}px)`,
        }}
      />
      <div
        role="status"
        data-slot="guide-callout-box"
        className="absolute flex w-max max-w-72 gap-2 rounded-xl bg-popover px-3.5 py-2.5 text-xs leading-relaxed text-popover-foreground shadow-md ring-1 ring-foreground/10"
        style={{ left: place.left, top: place.top, bottom: place.bottom }}
      >
        <span
          aria-hidden
          className={cn(
            "absolute size-2.5 rotate-45 bg-popover",
            below ? "-top-1" : "-bottom-1",
          )}
          style={{ left: `min(${tail}px, calc(100% - ${TAIL_INSET}px))` }}
        />
        <Compass
          aria-hidden
          className={cn("relative mt-0.5 size-3.5 shrink-0", TONE_MARK.sky)}
        />
        <p className="relative">{say}</p>
      </div>
    </div>
  );
}
