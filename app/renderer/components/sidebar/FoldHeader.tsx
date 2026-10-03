import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface FoldHeaderProps {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  Icon?: LucideIcon;
  // A tooltip saying what the fold holds.
  hint?: string;
}

// A header that folds the rows under it: label, hairline rule, chevron.
// Shut, the count stands for what it folds away. The inbox's shelves
// (InboxShelfRow) and the owners on the list of projects split by
// owner both head their rows with it.
export function FoldHeader({
  label,
  count,
  expanded,
  onToggle,
  Icon,
  hint,
}: FoldHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      title={hint}
      className="mt-2 flex w-full items-center gap-2 px-2 py-1 text-left text-muted-foreground transition-colors hover:text-foreground"
    >
      {Icon && <Icon aria-hidden className="size-3 shrink-0" />}
      <span className="min-w-0 truncate text-2xs font-medium">
        {expanded ? label : `${label} (${count})`}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
      <ChevronDown
        aria-hidden
        className={cn(
          "size-3 shrink-0 transition-transform",
          !expanded && "-rotate-90",
        )}
      />
    </button>
  );
}
