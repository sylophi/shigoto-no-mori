import { SHELF_LABELS, type GroupShelf } from "./sidebarRow";

interface ShelvedToggleRowProps {
  shelf: GroupShelf;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

export function ShelvedToggleRow({
  shelf,
  count,
  expanded,
  onToggle,
}: ShelvedToggleRowProps) {
  const label = SHELF_LABELS[shelf].toLowerCase();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="w-full px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {expanded ? `Hide ${label}` : `${count} ${label}`}
    </button>
  );
}
