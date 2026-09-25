// The floating surface menus and popovers share: Base UI's Menu and
// Popover parts are different components, so the look is lifted to
// constants rather than a shared wrapper, and the two can't drift.
export const FLOATING_POSITIONER_CLASS = "isolate z-50 outline-none";

export const FLOATING_SURFACE_CLASS =
  "z-50 max-h-(--available-height) origin-(--transform-origin) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95";
