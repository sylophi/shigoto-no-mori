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
import {
  useSetLaunchRowScript,
  useSetPackageScriptOrder,
  useSetPackageScriptSort,
  useSortedPackageScripts,
} from "@/hooks/scripts/usePackageScriptSort";
import { rankByScore } from "@/lib/fuzzyMatch";
import type { PackageScriptsResult, Worktree } from "@shared/schemas";
import { ArrangeScriptRow, ScriptDragPreview } from "./ArrangeScriptRow";
import { ScriptList } from "./ScriptList";
import { ScriptRow } from "./ScriptRow";
import { PackageScriptsView } from "./PackageScriptsView";

interface PackageScriptsProps {
  worktree: Worktree;
  pkg: PackageScriptsResult;
}

export function PackageScripts({ worktree, pkg }: PackageScriptsProps) {
  const [expanded, setExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const [arrangeRequested, setArrangeRequested] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const { sortMode, sorted } = useSortedPackageScripts(worktree.projectId, pkg);
  const setSortMode = useSetPackageScriptSort(worktree.projectId);
  const setOrder = useSetPackageScriptOrder(worktree.projectId);
  const setLaunchRow = useSetLaunchRowScript(worktree.projectId);
  const pinnedOf = (name: string) => pkg.launchRow.includes(name);
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
    <PackageScriptsView
      expanded={expanded}
      sortMode={sortMode}
      query={query}
      scripts={filtered}
      renderScript={(entry) => (
        <ScriptRow
          key={entry.name}
          worktree={worktree}
          slot={{ kind: "package", name: entry.name }}
          label={entry.name}
          command={entry.command}
        />
      )}
      arranging={arranging}
      arrangeList={
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
                <ArrangeScriptRow
                  key={name}
                  name={name}
                  pinned={pinnedOf(name)}
                  onPin={(onRow) =>
                    setLaunchRow.mutate({ scriptName: name, onRow })
                  }
                />
              ))}
            </ScriptList>
          </SortableContext>
          <DragOverlay>
            {dragging !== null && (
              <ScriptDragPreview name={dragging} pinned={pinnedOf(dragging)} />
            )}
          </DragOverlay>
        </DndContext>
      }
      onToggleExpanded={() => {
        setExpanded(!expanded);
        setArrangeRequested(false);
      }}
      onSort={(mode) => {
        // Picking a sort ends a request that a failed or remote
        // switch away from "manual" left standing, so choosing
        // "Manual order" later doesn't land back in arranging.
        setArrangeRequested(false);
        setSortMode.mutate(mode);
      }}
      onArrange={startArranging}
      onDoneArranging={() => setArrangeRequested(false)}
      onQuery={setQuery}
    />
  );
}
