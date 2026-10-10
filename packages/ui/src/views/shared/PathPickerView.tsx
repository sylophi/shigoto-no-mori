import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CornerLeftUp,
  Folder,
  Loader2,
  Search,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { PathSpan } from "../../primitives/path-span.tsx";
import { BrowseKeyHintsView } from "./BrowseListPartsView.tsx";
import { type PickerEntry, PickerRowView } from "./PickerRowView.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { FooterRow } from "../../primitives/footer-row.tsx";

// The folder browser behind the carry-over picker and the "leave out"
// pickers: a filter that owns the keyboard, folders to step into, and
// a trailing control per row the caller decides. The listing is a hook
// the caller hands in (carry-over unions every checkout, a pull reads
// its source worktree, the leave-out preset unions every device),
// called for the browsed folder.
export interface PathPickerProps<E extends PickerEntry> {
  // The root the relative paths hang off, for the header.
  rootPath: string;
  // The row's trailing control: added, an action, a note.
  // `insideIgnored`: a folder stepped into to reach the row is ignored.
  renderTrailing: (entry: E, path: string, insideIgnored: boolean) => ReactNode;
  // Extra per-row attribution, between the name and the control.
  renderProvenance?: (entry: E) => ReactNode;
  emptyRootLabel?: string;
  onClose: () => void;
}

export type PathListing<E> = {
  data: readonly E[] | undefined;
  isPending: boolean;
  error: unknown;
};

// The dialog's content: PathPickerModal holds the folders stepped into
// and lists the browsed one, and puts it in a ModalShell.
export function PathPickerView<E extends PickerEntry>({
  rootPath,
  home,
  parents,
  onParentsChange,
  listing: { data: listing, isPending, error },
  renderTrailing,
  renderProvenance,
  emptyRootLabel = "Project root is empty.",
  onClose,
}: PathPickerProps<E> & {
  // This device's home, which the header shortens to ~.
  home: string | null;
  // The folders stepped into, outermost first.
  parents: readonly E[];
  onParentsChange: (parents: readonly E[]) => void;
  // The browsed folder's listing.
  listing: PathListing<E>;
}) {
  const relative = parents.map((parent) => parent.name).join("/");
  const insideIgnored = parents.some((parent) => parent.ignored);
  const [filter, setFilter] = useState("");
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const atRoot = relative === "";
  const cwd = relative ? `${rootPath}/${relative}` : rootPath;

  const resetView = (nextParents: readonly E[]) => {
    onParentsChange(nextParents);
    setFilter("");
    setHighlightedIdx(0);
  };

  const goUp = () => {
    if (atRoot) return;
    resetView(parents.slice(0, -1));
  };

  const relativeFor = (name: string): string =>
    relative ? `${relative}/${name}` : name;

  const navigateInto = (entry: E) => {
    resetView([...parents, entry]);
  };

  const trimmed = filter.trim().toLowerCase();
  const entries = (listing ?? []).filter((e) =>
    trimmed ? e.name.toLowerCase().includes(trimmed) : true,
  );

  useEffect(() => {
    if (entries.length === 0) return;
    listRef.current
      ?.querySelector(`[data-row-idx="${highlightedIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedIdx, entries.length]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIdx((i) =>
        entries.length === 0 ? 0 : Math.min(i + 1, entries.length - 1),
      );
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter" || e.key === "ArrowRight") {
      const target = entries[highlightedIdx];
      if (target?.isDirectory) {
        e.preventDefault();
        navigateInto(target);
      }
      return;
    }
    if (e.key === "ArrowLeft" && filter === "" && !atRoot) {
      e.preventDefault();
      goUp();
    }
  };

  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        {!atRoot && (
          <IconButton onClick={goUp} aria-label="Go up">
            <ArrowLeft className="size-4" />
          </IconButton>
        )}
        <Folder className="size-4 shrink-0 text-muted-foreground/80" />
        <PathSpan
          path={cwd}
          home={home}
          className="min-w-0 flex-1 truncate font-mono text-sm select-text"
        />
        <IconButton onClick={onClose} aria-label="Close picker">
          <X className="size-4" />
        </IconButton>
      </header>

      <div
        data-slot="search-row"
        className="flex items-center gap-1.5 border-b border-border bg-card/40 px-3 py-1.5"
      >
        <Search className="size-3.5 text-muted-foreground" />
        <input
          type="text"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setHighlightedIdx(0);
          }}
          onKeyDown={onInputKeyDown}
          placeholder="Filter"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- picker just opened
          autoFocus
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
        />
      </div>

      <div className="min-h-[12rem] overflow-y-auto p-1">
        {!atRoot && (
          <button
            type="button"
            onClick={goUp}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <CornerLeftUp className="size-3.5" />
            <span className="font-mono">..</span>
          </button>
        )}

        {isPending ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            Couldn't read folder.
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {trimmed
              ? `No entries matching "${trimmed}".`
              : atRoot
                ? emptyRootLabel
                : "Empty folder."}
          </div>
        ) : (
          <ul ref={listRef} className="divide-y divide-border/40">
            {entries.map((entry, idx) => {
              const path = relativeFor(entry.name);
              return (
                <PickerRowView
                  key={entry.name}
                  entry={entry}
                  index={idx}
                  highlighted={idx === highlightedIdx}
                  onNavigate={() => navigateInto(entry)}
                  onHover={() => setHighlightedIdx(idx)}
                  provenance={renderProvenance?.(entry)}
                  trailing={renderTrailing(entry, path, insideIgnored)}
                />
              );
            })}
          </ul>
        )}
      </div>

      <FooterRow className="py-2">
        <BrowseKeyHintsView enterFolder goUp={!atRoot} />
      </FooterRow>
    </>
  );
}
