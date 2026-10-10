import { createContext, use, useRef, type ReactNode } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "../lib/utils.ts";
import {
  FLOATING_POSITIONER_CLASS,
  FLOATING_SURFACE_CLASS,
} from "./floating-surface.ts";
import type { WithoutTitle } from "./tooltip.tsx";
import { useThemeRoot } from "../root.tsx";

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

// No data-slot: it would replace the wrapped element's own (see
// DropdownMenuTrigger).
function PopoverTrigger({
  ...props
}: WithoutTitle<PopoverPrimitive.Trigger.Props>) {
  return <PopoverPrimitive.Trigger {...props} />;
}

// The dropdown menu's floating surface (floating-surface.ts), for
// content that isn't a menu: a list of links, a readout. Scrolls
// inside the space the window has left rather than running off it.
// A click or tap focuses the surface itself: Base UI would focus the
// first link, and Chrome rings a programmatic focus even after a
// click. A keyboard open still lands on the first link. That needs the
// popup's own ref, so the wrapper takes none from its caller.
function PopoverContent({
  className,
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: Omit<PopoverPrimitive.Popup.Props, "ref"> &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <PopoverPrimitive.Portal container={useThemeRoot() ?? undefined}>
      <PopoverPrimitive.Positioner
        className={FLOATING_POSITIONER_CLASS}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          ref={popupRef}
          initialFocus={(openType) =>
            openType === "keyboard" ? true : popupRef.current
          }
          className={cn(
            FLOATING_SURFACE_CLASS,
            "w-72 max-w-(--available-width)",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

// Closes the popover it sits in: a row that hands off to a dialog.
function PopoverClose({
  ...props
}: WithoutTitle<PopoverPrimitive.Close.Props>) {
  if (use(StaticPopoverContext)) {
    return (
      <button
        type="button"
        className={props.className as string | undefined}
        onClick={props.onClick}
      >
        {props.children as ReactNode}
      </button>
    );
  }
  return <PopoverPrimitive.Close {...props} />;
}

// A popover drawn open in place, for a scene (src/scenes): Base UI's
// popup needs an open popover and a portal, neither of which draws on a
// server, so this is its surface, and a close inside draws as a plain
// button. Placed by its parent, where the live one floats.
const StaticPopoverContext = createContext(false);

function StaticPopover({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <StaticPopoverContext value={true}>
      <div
        data-slot="popover-content"
        className={cn(FLOATING_SURFACE_CLASS, "w-72", className)}
      >
        {children}
      </div>
    </StaticPopoverContext>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverClose, StaticPopover };
