// The package.json part of the Scripts section as drawn
// (PackageScripts.tsx sorts, searches and arranges): the fold with the
// sort menu, then the search and the script grid, or the arranging
// list.
import type { ReactNode } from "react";
import { Check, ChevronRight, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { PackageScriptSortMode } from "@shared/schemas";
import { SortMenu } from "../SortMenu";
import { ScriptList } from "./ScriptList";
import { ScriptRowView } from "./ScriptRowView";
import type { SortableEntry } from "./sortPackageScripts";

const noop = () => undefined;

// A script's row before any run.
function idleScriptRow(entry: SortableEntry) {
  return (
    <ScriptRowView
      key={entry.name}
      label={entry.name}
      command={entry.command}
    />
  );
}

export function PackageScriptsView({
  expanded = true,
  sortMode,
  query = "",
  scripts,
  renderScript = idleScriptRow,
  arrangeList,
  onToggleExpanded,
  onSort = noop,
  onArrange = noop,
  onDoneArranging,
  onQuery,
}: {
  expanded?: boolean;
  sortMode: PackageScriptSortMode;
  query?: string;
  // The scripts the search leaves, in the sort's order.
  scripts: readonly SortableEntry[];
  // A live row per script. An idle ScriptRowView when not given.
  renderScript?: (entry: SortableEntry) => ReactNode;
  // The draggable list, while arranging: it takes the search and the
  // grid's place.
  arrangeList?: ReactNode;
  onToggleExpanded?: () => void;
  onSort?: (mode: PackageScriptSortMode) => void;
  onArrange?: () => void;
  onDoneArranging?: () => void;
  onQuery?: (query: string) => void;
}) {
  const arranging = arrangeList !== undefined;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs">
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          className="group -mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left transition-colors hover:bg-muted dark:hover:bg-muted/50"
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
              onClick={onDoneArranging}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <Check aria-hidden className="size-3" />
              <span>Done</span>
            </button>
          ) : (
            <SortMenu
              value={sortMode}
              onChange={onSort}
              onArrange={onArrange}
            />
          ))}
      </div>

      {expanded && arranging && (
        <>
          <p className="px-1 text-xs text-muted-foreground/70">
            Drag scripts into the order you want. Pin the ones the Launch
            section should show, or none to show as many as fit on a line.
          </p>
          {arrangeList}
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
              onChange={(e) => onQuery?.(e.target.value)}
              placeholder="Search scripts…"
              className="w-full py-1 pr-2.5 pl-7 text-xs"
            />
          </div>

          {scripts.length === 0 ? (
            <p className="p-1 text-xs text-muted-foreground/70">No matches.</p>
          ) : (
            <ScriptList>{scripts.map(renderScript)}</ScriptList>
          )}
        </>
      )}
    </div>
  );
}
