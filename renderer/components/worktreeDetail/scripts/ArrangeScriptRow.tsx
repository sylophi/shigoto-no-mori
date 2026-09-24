import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

// Same padding and type as ScriptRow, so the grid doesn't shift on the
// way in or out of arranging.
const CELL = "flex items-center gap-2 px-2.5 py-1.5 text-xs";

// A script's cell while the list is being arranged: the whole cell is the
// drag handle, and it runs nothing. The cell that's picked up stays behind
// as a dimmed marker of where the script will land, and ScriptDragPreview
// follows the pointer (the list's frame clips, so the cell itself can't).
export function ArrangeScriptRow({ name }: { name: string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: name });

  return (
    <div
      ref={setNodeRef}
      // Translate, not Transform: cells of different widths would
      // otherwise stretch to their target's size as they shift.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        CELL,
        "cursor-grab touch-none transition-colors select-none hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
        isDragging && "opacity-30",
      )}
      aria-label={`Move ${name}`}
      {...attributes}
      {...listeners}
    >
      <ScriptCellContent name={name} />
    </div>
  );
}

export function ScriptDragPreview({ name }: { name: string }) {
  return (
    <div
      className={cn(
        CELL,
        "cursor-grabbing rounded-md bg-card shadow-md outline -outline-offset-1 outline-foreground/25",
      )}
    >
      <ScriptCellContent name={name} />
    </div>
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
