import { useRef } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "@/lib/utils";
import {
  FLOATING_POSITIONER_CLASS,
  FLOATING_SURFACE_CLASS,
} from "./floating-surface";

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

// No data-slot: it would replace the wrapped element's own (see
// DropdownMenuTrigger).
function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
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
    <PopoverPrimitive.Portal>
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

export { Popover, PopoverTrigger, PopoverContent };
