import { Archive, EyeOff, GitMerge, type LucideIcon } from "lucide-react";
import { FoldHeader } from "../FoldHeader";
import type { InboxShelf } from "../sidebarRow";

const SHELVES: Record<
  InboxShelf,
  { label: string; Icon: LucideIcon; hint: string }
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
  hidden: {
    label: "Hidden",
    Icon: EyeOff,
    hint: "Worktrees that start with a hidden prefix",
  },
};

interface InboxShelfRowProps {
  shelf: InboxShelf;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

// A shelf header. Collapsed, the count is the shelf's whole footprint.
// That's the point, since every shelf holds work the user has already
// decided not to look at.
export function InboxShelfRow({
  shelf,
  count,
  expanded,
  onToggle,
}: InboxShelfRowProps) {
  const { label, Icon, hint } = SHELVES[shelf];
  return (
    <FoldHeader
      label={label}
      count={count}
      expanded={expanded}
      onToggle={onToggle}
      Icon={Icon}
      hint={hint}
    />
  );
}
