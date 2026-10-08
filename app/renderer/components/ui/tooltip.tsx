"use client";

import {
  cloneElement,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useRef,
  useState,
} from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { HTMLProps } from "@base-ui/react/types";
import { isTruncated } from "@/hooks/ui/useIsTruncated";

import { cn } from "@/lib/utils";

// 500ms before the first tooltip shows; once one is open, moving to a
// neighboring trigger shows its tooltip immediately (Base UI provider
// grouping), matching native-menu feel.
function TooltipProvider({
  delay = 500,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  );
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

// No data-slot: it would replace the wrapped element's own (see
// DropdownMenuTrigger).
function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "anchor" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        anchor={anchor}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

// The browser's own tooltip is banned (no-native-tooltip in
// lint/rules/no-native-tooltip.mts). A wrapper that passes its props to the DOM drops
// `title` from them with this, so `<Button title>` fails to type check
// where the lint rule, which can't see through a component, would miss
// it. Wrap the element in SimpleTooltip instead.
type WithoutTitle<Props> = Omit<Props, "title">;

type TooltipChild = ReactElement<
  HTMLProps & { ref?: Ref<HTMLElement>; disabled?: boolean }
>;

// Drop-in replacement for a native `title` hint: wraps one element
// with a styled tooltip without adding DOM (TooltipTrigger merges onto
// the child via the render prop, so the child needs to accept ref and
// event props on its root; plain DOM elements always do). A falsy tip
// shows nothing, mirroring `title={undefined}`, and keeps the same
// tree, so a tip that comes and goes doesn't remount the child (and
// take its focus). A disabled child still shows its tip (often the
// reason it's disabled), from a `display: contents` span around it:
// React drops mouse handlers on a disabled element, and Base UI opens
// on mousemove, but a wrapper's still run, and the span adds no box.
// (So a child that turns disabled is remounted into the span.)
// Newlines in string tips are preserved like multiline titles were.
// `delay` overrides the provider's opening delay for this trigger.
// `whenTruncated` is for a tip that only repeats text on screen in
// full: it opens only while that text is cut off. `lazy` is for such a
// tip on every row of a long list (the file tree, the palette), where
// most rows are never cut off: the tooltip isn't built until the
// pointer first finds the text cut off, the child rendering bare till
// then, and the next mousemove opens it. Building it remounts the
// child, so keep it to plain text that nothing anchors to or focuses.
function SimpleTooltip({
  tip,
  delay,
  whenTruncated,
  lazy,
  children,
}: {
  tip: ReactNode;
  delay?: number;
  whenTruncated?: boolean;
  lazy?: boolean;
  children: TooltipChild;
}) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const [armed, setArmed] = useState(false);
  const childDisabled = Boolean(children.props.disabled);
  if (lazy && whenTruncated && !armed && !childDisabled) {
    return cloneElement(children, {
      onPointerEnter: (event: PointerEvent<HTMLElement>) => {
        children.props.onPointerEnter?.(event);
        if (overflows(event.currentTarget)) setArmed(true);
      },
    });
  }
  return (
    <Tooltip
      disabled={!tip}
      onOpenChange={(open, details) => {
        if (open && whenTruncated && !overflows(details.trigger)) {
          details.cancel();
        }
      }}
    >
      {childDisabled ? (
        <TooltipTrigger
          render={
            <span ref={wrapperRef} className="contents">
              {children}
            </span>
          }
          delay={delay}
        />
      ) : (
        <TooltipTrigger
          ref={children.props.ref}
          render={withoutOpenState(children)}
          delay={delay}
        />
      )}
      {/* A contents span has no box to place the tip against, so it
          points at the child. */}
      <TooltipContent
        anchor={
          childDisabled
            ? () => wrapperRef.current?.firstElementChild ?? null
            : undefined
        }
      >
        {/* One wrapper span keeps a mixed text/element tip a single
            flex item: TooltipContent is inline-flex with a gap, which
            would otherwise space out every text run. pre-line preserves
            \n like the native titles this replaces. */}
        <span className="whitespace-pre-line">{tip}</span>
      </TooltipContent>
    </Tooltip>
  );
}

// Renders the child as the trigger, less the trigger's
// data-popup-open: an open menu, popover or context menu marks its
// trigger with that same attribute, so a hint over one (or over a row
// its context menu lights) would show it open. Otherwise Base UI's own
// merge for an element render: the child's props win, handlers chain,
// and the ref is the trigger's, which carries the child's (passed as
// the trigger's ref above).
function withoutOpenState(child: TooltipChild) {
  return ({
    "data-popup-open": _open,
    ...props
  }: HTMLProps & { "data-popup-open"?: string }) =>
    cloneElement(child, { ...mergeProps(props, child.props), ref: props.ref });
}

// Whether the trigger, or anything in it, is cut off.
function overflows(trigger: Element | undefined): boolean {
  if (!trigger) return false;
  return [trigger, ...trigger.querySelectorAll("*")].some(isTruncated);
}

export type { WithoutTitle };
export { SimpleTooltip, TooltipProvider };
