interface ShelvedToggleRowProps {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

export function ShelvedToggleRow({
  count,
  expanded,
  onToggle,
}: ShelvedToggleRowProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="w-full px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {expanded ? "Hide shelved" : `${count} shelved`}
    </button>
  );
}
