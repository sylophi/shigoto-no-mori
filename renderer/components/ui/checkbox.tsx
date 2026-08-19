import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// The app's checkbox. Still a native input, so it keeps the platform's
// semantics, keyboard behaviour and label association, but with the
// platform's own box switched off: an `accent-color` tint is the only
// thing a native checkbox will take, which leaves it square and flat in
// a theme where nothing else is. The tick is a sibling icon rather than
// a background image so its colour comes from a token like everything
// else, and `data-slot` gives doubutsu one hook for every checkbox in
// the app.
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
        className="peer size-4 appearance-none rounded-[4px] border border-input bg-background transition-colors checked:border-primary checked:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      />
      <Check
        aria-hidden
        className="pointer-events-none absolute inset-0 m-auto size-3 text-primary-foreground opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}
