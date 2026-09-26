import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pin } from "lucide-react";
import { cn } from "@/lib/utils";

// Same padding and type as ScriptRow, whose cell is also a wide button
// with a narrow one beside it, so the grid doesn't shift on the way in
// or out of arranging.
const CELL = "flex items-stretch text-xs";
const HANDLE = "flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5";
const PIN = "flex shrink-0 items-center px-2.5";

interface ArrangeScriptRowProps {
  name: string;
  // Undefined when the host predates pinning, which hides the toggle.
  pinned: boolean | undefined;
  onPin: (onRow: boolean) => void;
}

// A script's cell while the list is being arranged: the cell minus its
// pin toggle is the drag handle, and it runs nothing. The pin puts the
// script on the Launch section's row. The cell that's picked up stays
// behind as a dimmed marker of where the script will land, and
// ScriptDragPreview follows the pointer (the list's frame clips, so the
// cell itself can't).
export function ArrangeScriptRow({
  name,
  pinned,
  onPin,
}: ArrangeScriptRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: name });
  // A toggle's label stays put and aria-pressed carries the state. The
  // tooltip says what a click does.
  const pinLabel = `Pin ${name} to the Launch section`;

  return (
    <div
      ref={setNodeRef}
      // Translate, not Transform: cells of different widths would
      // otherwise stretch to their target's size as they shift.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(CELL, isDragging && "opacity-30")}
    >
      <div
        ref={setActivatorNodeRef}
        className={cn(
          HANDLE,
          "cursor-grab touch-none transition-colors select-none hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
        )}
        aria-label={`Move ${name}`}
        {...attributes}
        {...listeners}
      >
        <ScriptCellContent name={name} />
      </div>
      {pinned !== undefined && (
        <button
          type="button"
          onClick={() => onPin(!pinned)}
          aria-label={pinLabel}
          aria-pressed={pinned}
          title={pinned ? `Unpin ${name} from the Launch section` : pinLabel}
          className={cn(
            PIN,
            "transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
          )}
        >
          <PinIcon pinned={pinned} />
        </button>
      )}
    </div>
  );
}

export function ScriptDragPreview({
  name,
  pinned,
}: {
  name: string;
  pinned: boolean | undefined;
}) {
  return (
    <div
      className={cn(
        CELL,
        "cursor-grabbing rounded-md bg-card shadow-md outline -outline-offset-1 outline-foreground/25",
      )}
    >
      <div className={HANDLE}>
        <ScriptCellContent name={name} />
      </div>
      {pinned !== undefined && (
        <span className={PIN}>
          <PinIcon pinned={pinned} />
        </span>
      )}
    </div>
  );
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <Pin
      aria-hidden
      className={cn(
        "size-3",
        pinned ? "fill-current text-foreground" : "text-muted-foreground/60",
      )}
    />
  );
}

function ScriptCellContent({ name }: { name: string }) {
  return (
    <>
      <GripVertical
        aria-hidden
        className="size-3 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
    </>
  );
}
