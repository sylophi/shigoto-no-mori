// oxlint-disable-next-line no-restricted-imports -- React is used as a type-only namespace
import type * as React from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

// The app's checkbox, on the same Base UI footing as `ui/switch.tsx`.
// Base UI renders a real hidden input underneath, so native semantics,
// keyboard handling and label association all survive, and the
// `label:has(input[type="checkbox"])` row-hover hook doubutsu.css hangs
// off keeps matching.
//
// v1 draws the empty box the way the rest of v1 draws things, with a
// hairline. doubutsu strips hairlines, so it fills the box instead. See
// the `[data-unchecked]` rule in doubutsu.css.
//
// The destructive variant swaps which fill the ticked state takes. It
// exists for the one checkbox whose job is to confirm losing work, and
// it keeps the same weight as the default: the solid fill means ticked,
// either way round.
export function Checkbox({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  variant?: "default" | "destructive";
}) {
  const destructive = variant === "destructive";
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      data-variant={variant}
      className={cn(
        "peer size-4 shrink-0 rounded-[4px] border border-input bg-background transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        destructive
          ? "border-destructive/30 data-[checked]:border-destructive data-[checked]:bg-destructive"
          : "data-[checked]:border-primary data-[checked]:bg-primary",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className={cn(
          "flex items-center justify-center",
          // `text-background` rather than a foreground token: the tick
          // sits on the destructive fill, and the surface colour is the
          // one thing guaranteed to contrast with it in all four modes.
          destructive ? "text-background" : "text-primary-foreground",
        )}
      >
        <Check aria-hidden className="size-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
