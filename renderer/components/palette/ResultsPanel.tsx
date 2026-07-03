import type { KeyboardEvent } from "react";
import { Command } from "cmdk";
import { ArrowLeft, FolderSearch } from "lucide-react";
import { PathSpan } from "@/components/ui/path-span";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { modKey, shortcutLabel } from "@/lib/platform";
import { ResultRow } from "./ResultRow";

interface ResultsPanelProps {
  scanRoot: string;
  home: string | null;
  results: string[];
  selected: Set<string>;
  highlighted: string;
  onHighlightChange: (v: string) => void;
  onToggle: (path: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onBack: () => void;
  onAdd: () => Promise<void>;
  bulkAdding: boolean;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

export function ResultsPanel(props: ResultsPanelProps) {
  const allSelected =
    props.results.length > 0 && props.selected.size === props.results.length;

  return (
    <div onKeyDown={props.onKeyDown} role="group" aria-label="Scan results">
      <Command
        label="Scan results"
        loop
        shouldFilter={false}
        value={props.highlighted}
        onValueChange={props.onHighlightChange}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            onClick={props.onBack}
            aria-label="Back"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <FolderSearch className="size-4 shrink-0 text-muted-foreground/80" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-foreground">
              {props.results.length === 0
                ? "No new git repos found"
                : `${props.results.length} new git repo${props.results.length === 1 ? "" : "s"}`}
            </span>
            <span className="flex font-mono text-xs text-muted-foreground/70">
              <span className="shrink-0">in&nbsp;</span>
              <PathSpan
                path={props.scanRoot}
                home={props.home}
                className="min-w-0 flex-1 truncate"
              />
            </span>
          </div>
          {props.results.length > 0 && (
            <button
              type="button"
              onClick={allSelected ? props.onSelectNone : props.onSelectAll}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          )}
        </div>

        <Command.List className="max-h-96 overflow-y-auto p-2">
          {props.results.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              All git repos in this folder are already added.
            </div>
          ) : (
            props.results.map((path) => (
              <ResultRow
                key={path}
                path={path}
                scanRoot={props.scanRoot}
                home={props.home}
                isSelected={props.selected.has(path)}
                onToggle={() => props.onToggle(path)}
              />
            ))
          )}
        </Command.List>

        <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => void props.onAdd()}
            disabled={props.selected.size === 0 || props.bulkAdding}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span>
              {props.bulkAdding
                ? "Adding…"
                : `Add ${props.selected.size} project${props.selected.size === 1 ? "" : "s"}`}
            </span>
            <KbdGroup className="pointer-events-none">
              <Kbd>{shortcutLabel(modKey, "↩")}</Kbd>
            </KbdGroup>
          </button>
        </div>
      </Command>
    </div>
  );
}
