import { useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { ChevronsDownUp, ChevronsUpDown, Search } from "lucide-react";
import { DiffStats } from "@/components/ui/diff-stats";
import { useShortPath } from "@/hooks/ui/useShortPath";
import { cn } from "@/lib/utils";
import { CHANGE_MARKS, fileKey, fileStats } from "./patchFiles";

// The navigation rail for a multi-file patch: every file in the order it
// appears in the scroll area, with its change marker and +/- counts.
// Order is never re-ranked (that's why the filter is a plain substring
// match and not lib/fuzzyMatch) — the rail is a map of the scroll area,
// so it has to keep the scroll area's order to stay readable.
export function DiffFileIndex({
  files,
  activeKey,
  collapsedKeys,
  allCollapsed,
  onSelect,
  onToggleAll,
}: {
  files: FileDiffMetadata[];
  activeKey: string | null;
  collapsedKeys: ReadonlySet<string>;
  allCollapsed: boolean;
  onSelect: (key: string) => void;
  onToggleAll: () => void;
  // Visibility only; the caller owns the "is there room for a rail"
  // question because it owns the pane.
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? files.filter(
        (file) =>
          file.name.toLowerCase().includes(needle) ||
          file.prevName?.toLowerCase().includes(needle),
      )
    : files;

  return (
    <div
      data-slot="diff-index"
      className="flex w-72 shrink-0 flex-col border-r border-border"
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <Search
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              // Clear in place rather than letting Escape bubble out to
              // whatever the route does with it.
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder="Filter files"
          aria-label="Filter files"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
        />
        <button
          type="button"
          onClick={onToggleAll}
          title={allCollapsed ? "Expand all files" : "Collapse all files"}
          aria-label={allCollapsed ? "Expand all files" : "Collapse all files"}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {allCollapsed ? (
            <ChevronsUpDown aria-hidden className="size-3.5" />
          ) : (
            <ChevronsDownUp aria-hidden className="size-3.5" />
          )}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {matches.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No files match that filter.
          </p>
        ) : (
          matches.map((file) => {
            const key = fileKey(file);
            return (
              <IndexRow
                key={key}
                file={file}
                active={key === activeKey}
                collapsed={collapsedKeys.has(key)}
                onSelect={() => onSelect(key)}
              />
            );
          })
        )}
      </div>

      {needle && matches.length > 0 && (
        <p className="border-t border-border px-2.5 py-1 text-[11px] text-muted-foreground">
          {matches.length} of {files.length} files
        </p>
      )}
    </div>
  );
}

function IndexRow({
  file,
  active,
  collapsed,
  onSelect,
}: {
  file: FileDiffMetadata;
  active: boolean;
  collapsed: boolean;
  onSelect: () => void;
}) {
  // No home to tildify against: these are repo-relative paths, so the
  // helper only does the middle-segment abbreviation ("r/c/diff/x.tsx")
  // against the measured width of this row's path column.
  const [pathRef, display] = useShortPath(file.name, null);
  const cut = display.lastIndexOf("/");
  const { mark, label, className } = CHANGE_MARKS[file.type];
  const { additions, deletions } = fileStats(file);

  return (
    <button
      type="button"
      onClick={onSelect}
      data-active={active || undefined}
      title={
        file.prevName
          ? `${label}: ${file.prevName} → ${file.name}`
          : `${label}: ${file.name}`
      }
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50 hover:text-foreground",
        collapsed && "opacity-55",
      )}
    >
      <span
        aria-hidden
        className={cn("w-2 shrink-0 font-mono text-[10px]", className)}
      >
        {mark}
      </span>
      <span
        ref={pathRef}
        className="min-w-0 flex-1 truncate font-mono text-[11px]"
      >
        {cut >= 0 && (
          <span className="text-muted-foreground">
            {display.slice(0, cut + 1)}
          </span>
        )}
        {display.slice(cut + 1)}
      </span>
      <DiffStats additions={additions} deletions={deletions} />
    </button>
  );
}
