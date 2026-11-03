import type { ReactNode } from "react";
import { Radio } from "@base-ui/react/radio";
import { Check } from "lucide-react";
import { cn } from "../lib/utils.ts";

// One choice of a few, drawn as a card: a mark that fills once it is
// picked, its title, and a line under it. It goes in a Base UI
// RadioGroup, which carries the roles and the arrow keys.
export function OptionCard<T>({
  value,
  disabled,
  title,
  detail,
  className,
}: {
  value: T;
  disabled?: boolean;
  title: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <Radio.Root
      value={value}
      disabled={disabled}
      nativeButton
      // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- Radio.Root renders the card's content into it
      render={<button type="button" />}
      data-slot="option-card"
      className={cn(
        "group/option flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-left text-xs transition-colors outline-none not-data-checked:enabled:hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
        "data-checked:border-primary/40 data-checked:bg-accent data-checked:text-accent-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <span
          aria-hidden
          className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted-foreground/20 group-data-checked/option:bg-primary group-data-checked/option:text-primary-foreground"
        >
          <Check className="hidden size-2.5 group-data-checked/option:block" />
        </span>
        {title}
      </span>
      {detail !== undefined && (
        <span className="group-data-unchecked/option:text-muted-foreground">
          {detail}
        </span>
      )}
    </Radio.Root>
  );
}
