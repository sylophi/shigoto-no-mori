import type { KeyboardEvent, ReactNode } from "react";
import { Command } from "cmdk";
import { ArrowLeft, FolderSearch } from "lucide-react";
import { PathSpan } from "../../primitives/path-span.tsx";
import { KeyedButtonView } from "./DialogPartsView.tsx";
import { ResultRowView } from "./ResultRowView.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { MODAL_COMMAND_CLASS } from "../../primitives/cmdk-classes.ts";
import { pluralize } from "../../lib/pluralize.ts";

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
  terrierOptIn: ReactNode;
}

export function ResultsPanelView(props: ResultsPanelProps) {
  const allSelected =
    props.results.length > 0 && props.selected.size === props.results.length;

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- keyboard nav is delegated from the cmdk input; this wrapper only forwards it
    <div
      onKeyDown={props.onKeyDown}
      role="group"
      aria-label="Scan results"
      className="flex min-h-0 flex-col"
    >
      <Command
        label="Scan results"
        loop
        shouldFilter={false}
        value={props.highlighted}
        onValueChange={props.onHighlightChange}
        className={MODAL_COMMAND_CLASS}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <IconButton onClick={props.onBack} aria-label="Back">
            <ArrowLeft className="size-4" />
          </IconButton>
          <FolderSearch className="size-4 shrink-0 text-muted-foreground/80" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-foreground">
              {props.results.length === 0
                ? "No new git repos found"
                : pluralize(props.results.length, "new git repo")}
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

        <Command.List className="overflow-y-auto p-2">
          {props.results.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              All git repos in this folder are already added.
            </div>
          ) : (
            props.results.map((path) => (
              <ResultRowView
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

        <div
          data-slot="footer-row"
          className="flex items-center justify-end gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
        >
          {props.terrierOptIn}
          <KeyedButtonView
            label={
              props.bulkAdding
                ? "Adding…"
                : `Add ${pluralize(props.selected.size, "project")}`
            }
            keys="⌘↩"
            onClick={() => void props.onAdd()}
            disabled={props.selected.size === 0 || props.bulkAdding}
          />
        </div>
      </Command>
    </div>
  );
}
