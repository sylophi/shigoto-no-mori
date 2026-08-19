import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// The app's checkbox. A native checkbox only accepts an accent tint, so
// the platform box is switched off and this draws its own.
//
// Unchecked is a filled tile rather than an outline, taking the same
// `bg-input` track fill `ui/switch.tsx` uses. An empty box with a hairline
// border reads as unstyled in doubutsu, where every other control is a
// solid shape. Checked swaps the fill to `bg-primary`, so the pair says
// the same thing the switch's track does in either theme.
//
// The tick is a sibling icon rather than a background image so its
// colour comes from a token like everything else.
//
// `className` lands on the wrapper, which is what callers are
// positioning (mt-1 against a first line of text, and so on).
export function Checkbox({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <input
        type="checkbox"
        data-slot="checkbox"
        // `dark:checked:` is not redundant: `dark:bg-input/80` and
        // `checked:bg-primary` are the same specificity, so in dark mode
        // the unchecked fill would win on source order alone and a
        // ticked box would come out unfilled.
        className="peer size-4 appearance-none rounded-[4px] border border-transparent bg-input shadow-xs transition-colors outline-none checked:bg-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/80 dark:checked:bg-primary"
        {...props}
      />
      <Check
        aria-hidden
        strokeWidth={3}
        className="pointer-events-none absolute inset-0 m-auto size-3 text-primary-foreground opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}
