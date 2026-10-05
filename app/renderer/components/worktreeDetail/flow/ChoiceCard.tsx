// A radio card: one of a few mutually exclusive outcomes, its title,
// a line on what it means, and the destructive one in its warning
// colour. The transplant's finish (what becomes of the source) and the
// mirror's stop (what becomes of the copy) both pick with it, inside a
// role="radiogroup".
import { Check } from "lucide-react";
import { RowTag } from "@/components/ui/row-tag";
import { cn } from "@/lib/utils";

export function ChoiceCard({
  selected,
  disabled = false,
  onSelect,
  title,
  badge,
  body,
  tone,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  badge?: string;
  body: string;
  // The destructive option carries its own warning colour on its
  // title, selected or not.
  tone?: "rose";
}) {
  return (
    <button
      type="button"
      role="radio"
      data-slot="choice-card"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-3 text-left text-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        selected
          ? "border-primary/40 bg-accent text-accent-foreground"
          : "border-border bg-card hover:bg-muted/50",
        disabled && "cursor-not-allowed opacity-50 hover:bg-card",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full",
            selected
              ? "bg-primary text-primary-foreground"
              : "bg-muted-foreground/20",
          )}
        >
          {selected && <Check className="size-2.5" />}
        </span>
        <span
          className={cn(
            "text-sm font-medium",
            tone === "rose" && "text-rose-600 dark:text-rose-400",
          )}
        >
          {title}
        </span>
        {badge && (
          <span className="ml-auto">
            <RowTag>{badge}</RowTag>
          </span>
        )}
      </span>
      <span className={cn(!selected && "text-muted-foreground")}>{body}</span>
    </button>
  );
}
