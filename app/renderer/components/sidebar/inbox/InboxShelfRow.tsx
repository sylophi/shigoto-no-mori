import { Archive, EyeOff, GitMerge, type LucideIcon } from "lucide-react";
import { FoldHeader } from "../FoldHeader";
import type { InboxShelf } from "../sidebarRow";

const SHELVES: Record<InboxShelf, { label: string; Icon: LucideIcon }> = {
  shelved: { label: "Shelved", Icon: Archive },
  merged: { label: "Merged", Icon: GitMerge },
  hidden: { label: "Hidden", Icon: EyeOff },
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
  const { label, Icon } = SHELVES[shelf];
  return (
    <FoldHeader
      label={label}
      count={count}
      expanded={expanded}
      onToggle={onToggle}
      Icon={Icon}
    />
  );
}
