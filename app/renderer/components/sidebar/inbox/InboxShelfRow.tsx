import {
  Archive,
  EyeOff,
  GitMerge,
  Hammer,
  type LucideIcon,
} from "lucide-react";
import { FoldHeader } from "../FoldHeader";
import { SHELF_LABELS, type InboxShelf } from "../sidebarRow";

const ICONS: Record<InboxShelf, LucideIcon> = {
  agentWorking: Hammer,
  shelved: Archive,
  merged: GitMerge,
  hidden: EyeOff,
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
  return (
    <FoldHeader
      label={SHELF_LABELS[shelf]}
      count={count}
      expanded={expanded}
      onToggle={onToggle}
      Icon={ICONS[shelf]}
    />
  );
}
