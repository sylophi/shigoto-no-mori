import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { Check, ChevronRight, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  NO_ORDER,
  usePackageScriptOrder,
  usePackageScriptSort,
  useSetPackageScriptOrder,
  useSetPackageScriptSort,
} from "@/hooks/scripts/usePackageScriptSort";
import { rankByScore } from "@/lib/fuzzyMatch";
import { cn } from "@/lib/utils";
import type { PackageScriptsResult, Worktree } from "@shared/schemas";
import { ArrangeScriptRow, ScriptDragPreview } from "./ArrangeScriptRow";
import { ScriptList } from "./ScriptList";
import { ScriptRow } from "./ScriptRow";
import { SortMenu } from "../SortMenu";
import { sortEntries } from "./sortPackageScripts";

interface PackageScriptsProps {
  worktree: Worktree;
  pkg: PackageScriptsResult;
}

export function PackageScripts({ worktree, pkg }: PackageScriptsProps) {
  const [expanded, setExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const [arrangeRequested, setArrangeRequested] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const { data: sortMode = "frequent" } = usePackageScriptSort(
    worktree.projectId,
  );
  const setSortMode = useSetPackageScriptSort(worktree.projectId);
  const { data: order = NO_ORDER } = usePackageScriptOrder(
    worktree.projectId,
    sortMode,
  );
  const setOrder = useSetPackageScriptOrder(worktree.projectId);
  const entries = Object.entries(pkg.scripts);

  const sorted = sortEntries(entries, sortMode, pkg.usage, order);
  const names = sorted.map((e) => e.name);
  // Drags write the stored order, so arranging only lasts while the list
  // shows it: a refused or failed switch to "manual" (or another device
  // switching away) drops out of it instead of dragging a list whose
  // order won't follow.
  const arranging = arrangeRequested && sortMode === "manual";
  const filtered = rankByScore(query, sorted, (e) => e.name);

  // distance: 5 lets a quick click focus a cell without picking it up.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Arranging starts from the order on screen, whatever sort produced
  // it, so the first drag moves one script instead of reshuffling the
  // rest into package.json order. The search is dropped: a drag within
  // a filtered list has no clear place in the full one.
  const startArranging = () => {
    setOrder.mutate(names);
    if (sortMode !== "manual") setSortMode.mutate("manual");
    setQuery("");
    setArrangeRequested(true);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over || active.id === over.id) return;
    const from = names.indexOf(String(active.id));
    const to = names.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setOrder.mutate(arrayMove(names, from, to));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs">
        <button
          type="button"
          onClick={() => {
            setExpanded(!expanded);
            setArrangeRequested(false);
          }}
          aria-expanded={expanded}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 text-muted-foreground/60 transition-transform group-hover:text-muted-foreground",
              expanded && "rotate-90",
            )}
          />
          <span className="font-mono text-muted-foreground group-hover:text-foreground">
            package.json
          </span>
        </button>
        {expanded &&
          (arranging ? (
            <button
              type="button"
              onClick={() => setArrangeRequested(false)}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <Check aria-hidden className="size-3" />
              <span>Done</span>
            </button>
          ) : (
            <SortMenu
              value={sortMode}
              onChange={(mode) => {
                // Picking a sort ends a request that a failed or remote
                // switch away from "manual" left standing, so choosing
                // "Manual order" later doesn't land back in arranging.
                setArrangeRequested(false);
                setSortMode.mutate(mode);
              }}
              onArrange={startArranging}
            />
          ))}
      </div>

      {expanded && arranging && (
        <>
          <p className="px-1 text-xs text-muted-foreground/70">
            Drag scripts into the order you want.
          </p>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={({ active }: DragStartEvent) =>
              setDragging(String(active.id))
            }
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDragging(null)}
          >
            <SortableContext items={names} strategy={rectSortingStrategy}>
              <ScriptList>
                {names.map((name) => (
                  <ArrangeScriptRow key={name} name={name} />
                ))}
              </ScriptList>
            </SortableContext>
            <DragOverlay>
              {dragging !== null && <ScriptDragPreview name={dragging} />}
            </DragOverlay>
          </DndContext>
        </>
      )}

      {expanded && !arranging && (
        <>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground/60"
            />
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search scripts…"
              className="w-full py-1 pr-2.5 pl-7 text-xs"
            />
          </div>

          {filtered.length === 0 ? (
            <p className="p-1 text-xs text-muted-foreground/70">No matches.</p>
          ) : (
            <ScriptList>
              {filtered.map((entry) => (
                <ScriptRow
                  key={entry.name}
                  worktree={worktree}
                  slot={{ kind: "package", name: entry.name }}
                  label={entry.name}
                  command={entry.command}
                />
              ))}
            </ScriptList>
          )}
        </>
      )}
    </div>
  );
}
