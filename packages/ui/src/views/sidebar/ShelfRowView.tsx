import {
  Archive,
  EyeOff,
  GitMerge,
  Hammer,
  type LucideIcon,
} from "lucide-react";
import { FoldHeaderView } from "./FoldHeaderView.tsx";
import { SHELF_LABELS, type InboxShelf } from "./sidebarRow.ts";

const ICONS: Record<InboxShelf, LucideIcon> = {
  agentWorking: Hammer,
  shelved: Archive,
  merged: GitMerge,
  hidden: EyeOff,
};

interface ShelfRowProps {
  shelf: InboxShelf;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

// A shelf header, the inbox's and a tree group's alike. Collapsed, the
// count is the shelf's whole footprint. That's the point, since every
// shelf holds work the user has already decided not to look at.
export function ShelfRowView({
  shelf,
  count,
  expanded,
  onToggle,
}: ShelfRowProps) {
  return (
    <FoldHeaderView
      label={SHELF_LABELS[shelf]}
      count={count}
      expanded={expanded}
      onToggle={onToggle}
      Icon={ICONS[shelf]}
    />
  );
}
