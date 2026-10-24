// The bottom drawer a page's terminals sit in, over the footer and on
// its surface: a handle along its top edge that drags its height, by
// pointer or touch, over the tabs. Opened on the page, it slides up out
// of the footer. On a phone it is a sheet over the whole page
// instead (the page is `relative` for it), where a console has the room
// a script's output needs; its tabs' hide button closes it.
import { useRef, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export function TerminalDrawerView({
  height,
  onHeight,
  slideIn = false,
  children,
}: {
  // Null until the handle is dragged: half the window.
  height: number | null;
  // Opened just now on this page, not shown open by a page change.
  slideIn?: boolean;
  // A drag of the handle: the height it asks for.
  onHeight: (height: number) => void;
  children: ReactNode;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  return (
    <section
      ref={sectionRef}
      aria-label="Terminals"
      data-slot="terminal-drawer"
      style={{ height: height ?? "50dvh" }}
      className="relative flex shrink-0 flex-col border-t border-border bg-card phone:absolute phone:inset-0 phone:z-30 phone:h-auto! phone:border-t-0"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminals"
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none phone:hidden"
        onPointerDown={(event) => {
          const startY = event.clientY;
          const startHeight = sectionRef.current?.offsetHeight ?? 0;
          event.currentTarget.setPointerCapture(event.pointerId);
          const move = (moved: PointerEvent) =>
            onHeight(startHeight + startY - moved.clientY);
          const target = event.currentTarget;
          target.addEventListener("pointermove", move);
          target.addEventListener(
            "pointerup",
            () => target.removeEventListener("pointermove", move),
            { once: true },
          );
        }}
      />
      {/* Clipped, so the slide comes out from behind the footer. The
          box keeps its size meanwhile: only a transform moves, and the
          terminal does not refit on every frame. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "h-full",
            slideIn &&
              "duration-200 ease-(--ease-out-quart) motion-safe:animate-in motion-safe:slide-in-from-bottom",
          )}
        >
          {children}
        </div>
      </div>
    </section>
  );
}
