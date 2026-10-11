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
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import {
  useSetLaunchRowScript,
  useSetPackageScriptOrder,
  useSetPackageScriptSort,
  useSortedPackageScripts,
} from "@/hooks/scripts/usePackageScriptSort";
import { rankByScore } from "@/lib/fuzzyMatch";
import { cn } from "@/lib/utils";
import type { PackageScriptsResult, Worktree } from "@shared/schemas";
import { ArrangeScriptRow, ScriptDragPreview } from "./ArrangeScriptRow";
import { ScriptList } from "./ScriptList";
import { ScriptRow } from "./ScriptRow";
import { labelOf, scriptGroups, type ScriptGroup } from "./scriptGroups";
import type { SortableEntry } from "./sortPackageScripts";
import { SortMenu } from "../SortMenu";

interface PackageScriptsProps {
  worktree: Worktree;
  pkg: PackageScriptsResult;
}

// The worktree's scripts, a group per file they come from (package.json,
// the justfile, the Makefile), under one search and one sort: the sort
// and the manual order are the project's across every file.
export function PackageScripts({ worktree, pkg }: PackageScriptsProps) {
  const [query, setQuery] = useState("");
  const [arrangeRequested, setArrangeRequested] = useState(false);
  const { sortMode, sorted } = useSortedPackageScripts(worktree.projectId, pkg);
  const setSortMode = useSetPackageScriptSort(worktree.projectId);
  const setOrder = useSetPackageScriptOrder(worktree.projectId);
  // The sort and arrangement live on the host, so a peer that takes no
  // commands from here keeps its own.
  const { canCommand } = useCommandAccess();
  const names = sorted.map((e) => e.name);
  // Drags write the stored order, so arranging only lasts while the list
  // shows it: a refused or failed switch to "manual" (or another device
  // switching away) drops out of it instead of dragging a list whose
  // order won't follow.
  const arranging = canCommand && arrangeRequested && sortMode === "manual";
  // Arranging clears the search, so it always sees every group whole.
  // A search matches the name a script goes by in its file and the one
  // the launch row and ⌘K call it ("just build").
  const groups = scriptGroups(pkg).map((group) => ({
    group,
    entries: rankByScore(
      query,
      sorted.filter((e) => Object.hasOwn(group.labels, e.name)),
      (e) => [labelOf(group, e.name), e.name],
    ),
  }));

  // Arranging starts from the order on screen, whatever sort produced
  // it, so the first drag moves one script instead of reshuffling the
  // rest into file order. The search is dropped: a drag within a
  // filtered list has no clear place in the full one.
  const startArranging = () => {
    setOrder.mutate(names);
    if (sortMode !== "manual") setSortMode.mutate("manual");
    setQuery("");
    setArrangeRequested(true);
  };

  // A drag moves a script within its file's group. The stored order is
  // every file's, so the group's new order goes back into the places
  // its scripts held among the rest.
  const arrangeGroup = (arranged: string[]) => {
    const inGroup = new Set(arranged);
    const queue = [...arranged];
    setOrder.mutate(
      names.map((name) => (inGroup.has(name) ? (queue.shift() ?? name) : name)),
    );
  };

  return (
    <div className="space-y-3">
      {arranging ? (
        <div className="flex items-start gap-3 text-xs">
          <p className="flex-1 px-1 text-muted-foreground/70">
            Drag scripts into the order you want. Pin the ones the Launch
            section should show, or none to show as many as fit on a line.
          </p>
          <button
            type="button"
            onClick={() => setArrangeRequested(false)}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            <Check aria-hidden className="size-3" />
            <span>Done</span>
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs">
          <div className="relative flex-1">
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
          {canCommand && (
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
          )}
        </div>
      )}

      {/* A group the search empties stays mounted (FileScripts renders
          nothing), so a fold outlives the search. */}
      {groups.every(({ entries }) => entries.length === 0) && (
        <p className="p-1 text-xs text-muted-foreground/70">No matches.</p>
      )}
      {groups.map(({ group, entries }) => (
        <FileScripts
          key={group.file}
          worktree={worktree}
          launchRow={pkg.launchRow}
          group={group}
          entries={entries}
          arranging={arranging}
          onArrange={arrangeGroup}
        />
      ))}
    </div>
  );
}

interface FileScriptsProps {
  worktree: Worktree;
  launchRow: readonly string[];
  group: ScriptGroup;
  entries: readonly SortableEntry[];
  arranging: boolean;
  onArrange: (arranged: string[]) => void;
}

// One file's scripts under a heading that folds them away, each by the
// name it goes by in that file.
function FileScripts({
  worktree,
  launchRow,
  group,
  entries,
  arranging,
  onArrange,
}: FileScriptsProps) {
  const [expanded, setExpanded] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const setLaunchRow = useSetLaunchRowScript(worktree.projectId);
  const pinnedOf = (name: string) => launchRow.includes(name);
  const names = entries.map((e) => e.name);

  // distance: 5 lets a quick click focus a cell without picking it up.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over || active.id === over.id) return;
    const from = names.indexOf(String(active.id));
    const to = names.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onArrange(arrayMove(names, from, to));
  };

  if (entries.length === 0) return null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="group -mx-1 flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-xs transition-colors hover:bg-muted dark:hover:bg-muted/50"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 text-muted-foreground/60 transition-transform group-hover:text-muted-foreground",
            expanded && "rotate-90",
          )}
        />
        <span className="font-mono text-muted-foreground group-hover:text-foreground">
          {group.file}
        </span>
      </button>

      {expanded &&
        (arranging ? (
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
                    label={labelOf(group, name)}
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
                <ScriptDragPreview
                  label={labelOf(group, dragging)}
                  pinned={pinnedOf(dragging)}
                />
              )}
            </DragOverlay>
          </DndContext>
        ) : (
          <ScriptList>
            {entries.map((entry) => (
              <ScriptRow
                key={entry.name}
                worktree={worktree}
                slot={{ kind: "package", name: entry.name }}
                label={labelOf(group, entry.name)}
                command={entry.command}
              />
            ))}
          </ScriptList>
        ))}
    </div>
  );
}
