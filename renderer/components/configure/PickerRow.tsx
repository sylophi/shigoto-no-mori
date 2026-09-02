import { Copy as CopyIcon, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MaterialIcon } from "@/components/ui/material-icon";
import { cn } from "@/lib/utils";
import type { CarryOverCandidate, CarryOverEntry } from "@shared/schemas";
import { OnlyInWorktrees } from "./OnlyInWorktrees";

interface PickerRowProps {
  entry: CarryOverCandidate;
  added: boolean;
  // .worktreeinclude already copies this path into every new worktree; a
  // manual entry would be auto-removed at the next creation.
  covered: boolean;
  index: number;
  highlighted: boolean;
  onNavigate: () => void;
  onHover: () => void;
  onPick: (mode: CarryOverEntry["mode"]) => void;
}

export function PickerRow({
  entry,
  added,
  covered,
  index,
  highlighted,
  onNavigate,
  onHover,
  onPick,
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
      <OnlyInWorktrees
        inPrimary={entry.inPrimary}
        worktrees={entry.worktrees}
        className="max-w-40"
      />
      {added ? (
        <span className="px-2 text-[11px] text-muted-foreground">Added</span>
      ) : covered ? (
        <span
          className="px-2 text-[11px] text-amber-600 dark:text-amber-400"
          title=".worktreeinclude already copies this path into every new worktree."
        >
          covered
        </span>
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
