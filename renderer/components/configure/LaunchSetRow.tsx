import { Plus, X } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChipButton } from "@/components/ui/chip-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { LauncherIcon } from "@/components/LauncherIcon";
import { cn } from "@/lib/utils";
import type { LauncherEntry, LaunchSet } from "@shared/schemas";

interface LaunchSetRowProps {
  set: LaunchSet;
  // Everything the project can launch today, in row order. Members whose
  // id isn't in here still render -- the tool may be back tomorrow.
  entries: LauncherEntry[];
  autoLaunch: boolean;
  onRename: (label: string) => void;
  onRemove: () => void;
  onAddMember: (launcherId: string) => void;
  onRemoveMember: (launcherId: string) => void;
  onMoveMember: (draggedId: string, targetId: string) => void;
  onToggleAutoLaunch: (enabled: boolean) => void;
}

export function LaunchSetRow({
  set,
  entries,
  autoLaunch,
  onRename,
  onRemove,
  onAddMember,
  onRemoveMember,
  onMoveMember,
  onToggleAutoLaunch,
}: LaunchSetRowProps) {
  // distance: 5 keeps a plain click on a chip working (it removes the
  // member); a drag only takes over once the pointer travels. Same
  // activation constraint the sidebar's project reorder uses.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    onMoveMember(String(active.id), String(over.id));
  };

  const available = entries.filter((e) => !set.launcherIds.includes(e.id));

  return (
    <div className="space-y-2.5 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={set.label}
          onChange={(e) => onRename(e.target.value)}
          placeholder="Set name"
          aria-label="Launch set name"
          className="max-w-[16rem] min-w-0 px-2.5 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove launch set"
          className="ml-auto rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="size-4" />
        </button>
      </div>

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext
          items={set.launcherIds}
          strategy={horizontalListSortingStrategy}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {set.launcherIds.map((id) => (
              <MemberChip
                key={id}
                launcherId={id}
                entry={entries.find((e) => e.id === id)}
                onRemove={() => onRemoveMember(id)}
              />
            ))}
            {available.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <ChipButton>
                      <Plus className="size-3" />
                      Add tool
                    </ChipButton>
                  }
                />
                <DropdownMenuContent align="start" sideOffset={4}>
                  {available.map((entry) => (
                    <DropdownMenuItem
                      key={entry.id}
                      onClick={() => onAddMember(entry.id)}
                    >
                      <LauncherIcon entry={entry} className="size-3.5" />
                      {entry.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </SortableContext>
      </DndContext>

      {set.launcherIds.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">
          Empty sets are dropped on save.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground/70">
          Launches left to right. Drag to reorder, click a tool to remove it.
        </p>
      )}

      <div className="flex items-center gap-2.5 pt-0.5">
        <Switch
          checked={autoLaunch}
          onCheckedChange={onToggleAutoLaunch}
          aria-label={`Run ${set.label || "this set"} in new worktrees`}
        />
        <span className="text-xs text-muted-foreground">
          Run in new worktrees, once carry-over and setup finish
        </span>
      </div>
    </div>
  );
}

// A member of the set. The chip itself is the remove control (click to
// drop the tool) and the drag handle -- nesting a button inside a button
// isn't legal markup, and the chip is small enough that a dedicated
// handle would dominate it.
function MemberChip({
  launcherId,
  entry,
  onRemove,
}: {
  launcherId: string;
  entry: LauncherEntry | undefined;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: launcherId });
  const label = entry?.label ?? launcherId;

  return (
    <ChipButton
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "cursor-grab",
        isDragging && "opacity-50",
        // An id nothing resolves to still launches fine if the app comes
        // back, so it's dimmed rather than flagged as an error.
        !entry && "text-muted-foreground/60",
      )}
      onClick={onRemove}
      aria-label={`Remove ${label} from the set`}
      title={
        entry
          ? `Remove ${label} from the set`
          : `${launcherId} isn't available right now`
      }
      {...attributes}
      {...listeners}
    >
      {entry ? (
        <LauncherIcon entry={entry} className="size-3.5" />
      ) : (
        <X className="size-3" />
      )}
      <span>{label}</span>
    </ChipButton>
  );
}
