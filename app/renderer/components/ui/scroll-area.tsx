import type { Ref } from "react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "@/lib/utils";

interface ScrollAreaProps extends ScrollAreaPrimitive.Root.Props {
  viewportRef?: Ref<HTMLDivElement>;
}

function ScrollArea({
  className,
  children,
  viewportRef,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      // The native scrollbar's pill, drawn in the DOM from the same
      // --scrollbar-* tokens (index.css).
      className={cn(
        "flex touch-none rounded-full bg-(--scrollbar-track) bg-clip-content p-(--scrollbar-inset) select-none data-[orientation=horizontal]:h-(--scrollbar-size) data-[orientation=horizontal]:flex-col data-[orientation=vertical]:h-full data-[orientation=vertical]:w-(--scrollbar-size)",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        // Widens under the pointer by bleeding across the bar's inset
        // rather than changing the bar's padding, which Base UI reads
        // only on scroll to place the thumb.
        className="relative flex-1 rounded-full bg-(--scrollbar-thumb) bg-size-[12px_12px] hover:bg-(--scrollbar-thumb-hover) hover:bg-(image:--scrollbar-thumb-hover-image) active:bg-(--scrollbar-thumb-hover) active:bg-(image:--scrollbar-thumb-hover-image) data-[orientation=horizontal]:[&:is(:hover,:active)]:my-[calc(var(--scrollbar-inset-hover)-var(--scrollbar-inset))] data-[orientation=vertical]:[&:is(:hover,:active)]:mx-[calc(var(--scrollbar-inset-hover)-var(--scrollbar-inset))]"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
