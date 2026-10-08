import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/components/ui/tooltip";

interface FoldHeaderProps {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  Icon?: LucideIcon;
}

// A header that folds the rows under it: label, hairline rule, chevron.
// Shut, the count stands for what it folds away. The inbox's shelves
// (InboxShelfRow), the owners on the list of projects split by owner,
// and the prefix groups, a project's and the inbox's, all head their
// rows with it.
export function FoldHeader({
  label,
  count,
  expanded,
  onToggle,
  Icon,
}: FoldHeaderProps) {
  const text = expanded ? label : `${label} (${count})`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="mt-2 flex w-full items-center gap-2 px-2 py-1 text-left text-muted-foreground transition-colors hover:text-foreground"
    >
      {Icon && <Icon aria-hidden className="size-3 shrink-0" />}
      <SimpleTooltip whenTruncated tip={text}>
        <span className="min-w-0 truncate text-2xs font-medium">{text}</span>
      </SimpleTooltip>
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
