import { Archive, ChevronDown, GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InboxShelf } from "../sidebarRow";

const SHELVES: Record<
  InboxShelf,
  { label: string; Icon: typeof Archive; hint: string }
> = {
  shelved: {
    label: "Shelved",
    Icon: Archive,
    hint: "Worktrees you've put out of focus",
  },
  merged: {
    label: "Merged",
    Icon: GitMerge,
    hint: "Branches already landed on the primary, or with a merged PR",
  },
};

interface InboxShelfRowProps {
  shelf: InboxShelf;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

// A shelf header: label, hairline rule, chevron. Collapsed, the count is
// the shelf's whole footprint -- which is the point, since both shelves
// hold work the user has already decided not to look at.
export function InboxShelfRow({
  shelf,
  count,
  expanded,
  onToggle,
}: InboxShelfRowProps) {
  const { label, Icon, hint } = SHELVES[shelf];
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      title={hint}
      className="mt-2 flex w-full items-center gap-2 px-2 py-1 text-left text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="text-[11px] font-medium">
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
