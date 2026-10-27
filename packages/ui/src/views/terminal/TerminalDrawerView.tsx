// The drawer a page's terminals sit in, on its surface: docked at the
// bottom, over the footer, or at the side, beside the whole page. A
// handle along its inner edge drags its size, by pointer or touch.
// Opened on the page, it slides out of the edge it is docked to. On a
// phone it is a sheet over the whole page instead (the page is
// `relative` for it), where a console has the room a script's output
// needs; its tabs' hide button closes it.
import { useRef, type ReactNode } from "react";
import { cn, dragRegion } from "../../lib/utils.ts";

// Its shortest and narrowest, the share of the window's height it may
// take, and the room it leaves the page beside it.
const MIN_HEIGHT = 120;
const MIN_WIDTH = 320;
const MAX_SHARE = 0.8;
const PAGE_ROOM = 352;

export function TerminalDrawerView({
  side = false,
  size,
  onSize,
  slideIn = false,
  children,
}: {
  side?: boolean;
  // Its height at the bottom, its width at the side. Null until the
  // handle is dragged: half the window's height, or 40% of the page's
  // width.
  size: number | null;
  // Opened just now on this page, not shown open by a page change.
  slideIn?: boolean;
  // A drag of the handle: the size it asks for, within its limits.
  onSize: (size: number) => void;
  children: ReactNode;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  return (
    <section
      ref={sectionRef}
      aria-label="Terminals"
      data-slot="terminal-drawer"
      style={
        side
          ? { width: size ?? "40%", maxWidth: `calc(100% - ${PAGE_ROOM}px)` }
          : { height: size ?? "50dvh", maxHeight: `${MAX_SHARE * 100}dvh` }
      }
      className={cn(
        "relative flex shrink-0 flex-col border-border bg-card phone:absolute phone:inset-0 phone:z-30",
        side
          ? "border-l phone:w-auto! phone:max-w-none! phone:border-l-0"
          : "border-t phone:h-auto! phone:max-h-none! phone:border-t-0",
      )}
    >
      <div
        role="separator"
        aria-orientation={side ? "vertical" : "horizontal"}
        aria-label="Resize terminals"
        className={cn(
          "absolute z-10 touch-none phone:hidden",
          side
            ? "inset-y-0 -left-1 w-2 cursor-col-resize"
            : "inset-x-0 -top-1 h-2 cursor-row-resize",
        )}
        // At the side its top is under the window's title-bar drag strip.
        style={dragRegion("no-drag")}
        onPointerDown={(event) => {
          const at = (pointer: { clientX: number; clientY: number }) =>
            side ? pointer.clientX : pointer.clientY;
          const start = at(event);
          const section = sectionRef.current;
          const startSize =
            (side ? section?.offsetWidth : section?.offsetHeight) ?? 0;
          const [min, max] = side
            ? [
                MIN_WIDTH,
                (section?.parentElement?.clientWidth ?? 0) - PAGE_ROOM,
              ]
            : [MIN_HEIGHT, window.innerHeight * MAX_SHARE];
          event.currentTarget.setPointerCapture(event.pointerId);
          const move = (moved: PointerEvent) =>
            onSize(
              Math.round(
                Math.max(Math.min(startSize + start - at(moved), max), min),
              ),
            );
          const target = event.currentTarget;
          target.addEventListener("pointermove", move);
          target.addEventListener(
            "pointerup",
            () => target.removeEventListener("pointermove", move),
            { once: true },
          );
        }}
      />
      {/* Clipped, so the slide comes out from behind the edge. The box
          keeps its size meanwhile: only a transform moves, and the
          terminal does not refit on every frame. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "h-full",
            slideIn && [
              "duration-200 ease-(--ease-out-quart) motion-safe:animate-in",
              side
                ? "motion-safe:slide-in-from-right"
                : "motion-safe:slide-in-from-bottom",
            ],
          )}
        >
          {children}
        </div>
      </div>
    </section>
  );
}
