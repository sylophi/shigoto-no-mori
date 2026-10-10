// The bottom drawer a page's terminals sit in: a handle along its top
// edge that drags its height, over the tabs.
import type { ReactNode } from "react";

export function TerminalDrawerView({
  height,
  onHeight,
  children,
}: {
  height: number;
  // A drag of the handle: the height it asks for.
  onHeight: (height: number) => void;
  children: ReactNode;
}) {
  return (
    <section
      aria-label="Terminals"
      data-slot="terminal-drawer"
      style={{ height }}
      className="relative flex shrink-0 flex-col border-t border-border bg-background"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminals"
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
        onPointerDown={(event) => {
          const startY = event.clientY;
          event.currentTarget.setPointerCapture(event.pointerId);
          const move = (moved: PointerEvent) =>
            onHeight(height + startY - moved.clientY);
          const target = event.currentTarget;
          target.addEventListener("pointermove", move);
          target.addEventListener(
            "pointerup",
            () => target.removeEventListener("pointermove", move),
            { once: true },
          );
        }}
      />
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
