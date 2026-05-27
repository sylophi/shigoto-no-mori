import { Copy as CopyIcon, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MaterialIcon } from "@/components/ui/material-icon";
import { cn } from "@/lib/utils";
import type { CarryOverEntry, FsEntry } from "@shared/schemas";

interface PickerRowProps {
  entry: FsEntry;
  added: boolean;
  ignored: boolean;
  index: number;
  highlighted: boolean;
  onNavigate: () => void;
  onHover: () => void;
  onPick: (mode: CarryOverEntry["mode"]) => void;
}

export function PickerRow({
  entry,
  added,
  ignored,
  index,
  highlighted,
  onNavigate,
  onHover,
  onPick,
}: PickerRowProps) {
  const isFolder = entry.isDirectory;
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keyboard nav lives on the focused filter input above
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
      {added ? (
        <span className="px-2 text-[11px] text-muted-foreground">Added</span>
      ) : ignored ? (
        <div
          className="inline-flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onPick("symlink")}
            title="Edits stay in sync with the main checkout"
          >
            <LinkIcon />
            Symlink
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onPick("copy")}
            title="Independent snapshot at worktree creation"
          >
            <CopyIcon />
            Copy
          </Button>
        </div>
      ) : (
        <span
          className="px-2 text-[11px] text-muted-foreground/70"
          title="Tracked by git. Only ignored files and folders can be carried over."
        >
          tracked
        </span>
      )}
    </li>
  );
}
