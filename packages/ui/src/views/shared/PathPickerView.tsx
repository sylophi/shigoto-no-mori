import { useState } from "react";
import type { ReactNode } from "react";
import { Command } from "cmdk";
import { ArrowLeft, Folder, Search, X } from "lucide-react";
import { PathSpan } from "../../primitives/path-span.tsx";
import { MaterialIcon } from "../../primitives/material-icon.tsx";
import { MODAL_COMMAND_CLASS } from "../../primitives/cmdk-classes.ts";
import {
  BROWSE_UP,
  BrowseKeyHintsView,
  BrowseListView,
  browseValue,
} from "./BrowseListPartsView.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { FooterRow } from "../../primitives/footer-row.tsx";

// What a picker row needs of an entry. The carry-over candidate, the
// worktree folder entry and the repo listing entry all carry these
// three.
export interface PickerEntry {
  name: string;
  isDirectory: boolean;
  ignored: boolean;
}

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
  const [highlighted, setHighlighted] = useState("");
  const atRoot = relative === "";
  const cwd = relative ? `${rootPath}/${relative}` : rootPath;

  const resetView = (nextParents: readonly E[]) => {
    onParentsChange(nextParents);
    setFilter("");
    setHighlighted("");
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

  // The first entry stays highlighted until another row is, as it is
  // when a folder opens or the filter changes.
  const valueOf = (entry: E) => browseValue(relativeFor(entry.name));
  const rows = [...(atRoot ? [] : [BROWSE_UP]), ...entries.map(valueOf)];
  const active = rows.includes(highlighted)
    ? highlighted
    : entries[0]
      ? valueOf(entries[0])
      : "";
  const activeEntry = entries.find((entry) => valueOf(entry) === active);

  const open = (entry: E) => {
    if (entry.isDirectory) navigateInto(entry);
  };

  // ↑, ↓ and ↩ are the list's (cmdk's).
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowRight" && activeEntry?.isDirectory) {
      e.preventDefault();
      navigateInto(activeEntry);
      return;
    }
    if (e.key === "ArrowLeft" && filter === "" && !atRoot) {
      e.preventDefault();
      goUp();
    }
  };

  return (
    <Command
      label="Browse folders"
      loop
      shouldFilter={false}
      value={active}
      // While a folder loads, cmdk highlights its only row, `..`, which
      // would keep the first entry from taking over once it lands.
      onValueChange={(value) => {
        if (!isPending) setHighlighted(value);
      }}
      className={MODAL_COMMAND_CLASS}
    >
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
            setHighlighted("");
          }}
          onKeyDown={onInputKeyDown}
          placeholder="Filter"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- picker just opened
          autoFocus
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
        />
      </div>

      <BrowseListView
        entries={entries}
        pathOf={(entry) => relativeFor(entry.name)}
        highlighted={active}
        onUp={atRoot ? undefined : goUp}
        onOpen={open}
        renderIcon={(entry, lit) => (
          <MaterialIcon
            kind={entry.isDirectory ? "folder" : "file"}
            name={entry.name}
            expanded={entry.isDirectory && lit}
            className="size-4"
          />
        )}
        label={(entry) => (entry.isDirectory ? `${entry.name}/` : entry.name)}
        dim={(entry) => !entry.isDirectory && !entry.ignored}
        renderTrailing={(entry, path) => (
          <>
            {renderProvenance?.(entry)}
            {renderTrailing(entry, path, insideIgnored)}
          </>
        )}
        loading={isPending}
        error={Boolean(error)}
        noMatch={trimmed ? `No entries matching “${trimmed}”.` : undefined}
        emptyLabel={atRoot ? emptyRootLabel : undefined}
        className="min-h-[12rem] p-1"
      />

      <FooterRow className="py-2">
        <BrowseKeyHintsView enterFolder goUp={!atRoot} />
      </FooterRow>
    </Command>
  );
}
