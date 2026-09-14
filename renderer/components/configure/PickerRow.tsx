import type { ReactNode } from "react";
import { MaterialIcon } from "@/components/ui/material-icon";
import { cn } from "@/lib/utils";

// What a picker row needs of an entry. The carry-over candidate and
// the mirror's folder entry both carry these three.
export interface PickerEntry {
  name: string;
  isDirectory: boolean;
  ignored: boolean;
}

interface PickerRowProps {
  entry: PickerEntry;
  index: number;
  highlighted: boolean;
  onNavigate: () => void;
  onHover: () => void;
  // Attribution between the name and the control (where a carry-over
  // path was found), and the control itself.
  provenance?: ReactNode;
  trailing: ReactNode;
}

export function PickerRow({
  entry,
  index,
  highlighted,
  onNavigate,
  onHover,
  provenance,
  trailing,
}: PickerRowProps) {
  const { isDirectory: isFolder, ignored } = entry;
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- keyboard nav lives on the focused filter input above
    <li
      data-row-idx={index}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 py-1.5",
        isFolder && "cursor-pointer",
        highlighted && "bg-accent text-accent-foreground",
        !isFolder && !ignored && !highlighted && "opacity-60",
      )}
      onClick={isFolder ? onNavigate : undefined}
      onMouseEnter={onHover}
    >
      <MaterialIcon
        kind={isFolder ? "folder" : "file"}
        name={entry.name}
        expanded={isFolder && highlighted}
        className="size-4"
      />
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs"
        title={entry.name}
      >
        {entry.name}
        {isFolder ? "/" : ""}
      </span>
      {provenance}
      {trailing}
    </li>
  );
}
