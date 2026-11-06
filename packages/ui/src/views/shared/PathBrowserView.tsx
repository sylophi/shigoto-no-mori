import type { KeyboardEvent, ReactNode, Ref } from "react";
import { Command } from "cmdk";
import { Folder } from "lucide-react";
import type { BrowseListing } from "../../lib/browseListing.ts";
import { cn } from "../../lib/utils.ts";
import { Button } from "../../primitives/button.tsx";
import {
  keepFocusInInput,
  MODAL_COMMAND_CLASS,
} from "../../primitives/cmdk-classes.ts";
import { FooterRow } from "../../primitives/footer-row.tsx";
import {
  BrowseKeyHintsView,
  BrowseListView,
  isBrowseRow,
} from "./BrowseListPartsView.tsx";

type BrowseEntry = BrowseListing["filtered"][number];

// A typed path browsed as folders, for the folder picker and Add
// Project's browse stage: the input is the path, listed live, beside the
// button that takes it, over the `..` row and the folders, with the key
// hints in the footer. The keys on the input are the container's.
export function PathBrowserView({
  label,
  placeholder,
  query,
  onQuery,
  inputRef,
  onInputKeyDown,
  highlighted,
  onHighlight,
  browse,
  browsable = true,
  canBrowseUp,
  primary,
  confirmKeys,
  hint,
  renderIcon,
  renderTrailing,
  footerEnd,
}: {
  label: string;
  placeholder: string;
  query: string;
  onQuery: (query: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  highlighted: string;
  onHighlight: (value: string) => void;
  browse: BrowseListing;
  // Off where the folders can't be listed (an offline device's): the
  // path is typed, with no list under it.
  browsable?: boolean;
  canBrowseUp: boolean;
  primary: { label: ReactNode; disabled: boolean; onClick: () => void };
  // The keys that press the primary button past a highlighted row (the
  // keymap's). With none highlighted ↩ does.
  confirmKeys: string;
  // One line under the input saying what the folder is for.
  hint?: string;
  // A folder's mark, a plain folder unless given.
  renderIcon?: (entry: BrowseEntry) => ReactNode;
  // What ends a folder's row, by its path.
  renderTrailing?: (entry: BrowseEntry, path: string) => ReactNode;
  footerEnd?: ReactNode;
}) {
  const { browseDir, leafFilter, listing, isLoading, error, filtered } = browse;
  const hasHighlighted = isBrowseRow(highlighted);

  return (
    <Command
      label={label}
      loop
      shouldFilter={false}
      value={highlighted}
      onValueChange={onHighlight}
      // Fills what holds it, so its footer sits at the bottom however few
      // folders the list has.
      className={cn(MODAL_COMMAND_CLASS, "flex-1")}
    >
      <div
        data-slot="search-row"
        className="relative flex items-center gap-2 border-b border-border px-3 py-2"
      >
        <Command.Input
          ref={inputRef}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the input is the path, and the flow starts there
          autoFocus
          value={query}
          onValueChange={onQuery}
          onKeyDown={onInputKeyDown}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent py-1 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
        />
        <Button
          variant="outline"
          size="xs"
          keys={hasHighlighted ? confirmKeys : "↩"}
          onMouseDown={keepFocusInInput}
          onClick={primary.onClick}
          disabled={primary.disabled}
        >
          {primary.label}
        </Button>
      </div>
      {hint && (
        <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {hint}
        </p>
      )}

      {browsable && (
        <>
          <BrowseListView
            entries={filtered}
            pathOf={(entry) => `${browseDir}${entry.name}`}
            highlighted={highlighted}
            onUp={canBrowseUp ? browse.browseUp : undefined}
            onOpen={(entry) => browse.browseTo(entry.name)}
            renderIcon={(entry) =>
              renderIcon?.(entry) ?? (
                <Folder className="size-4 text-muted-foreground/80" />
              )
            }
            renderTrailing={renderTrailing}
            loading={isLoading && !listing}
            error={error !== null}
            noMatch={
              leafFilter.length > 0
                ? `No folders matching "${leafFilter}".`
                : undefined
            }
            className="min-h-0 flex-1 p-2"
          />

          <FooterRow className="justify-between">
            <div className="flex items-center gap-3">
              <BrowseKeyHintsView
                enterFolder={hasHighlighted}
                goUp={canBrowseUp}
              />
            </div>
            {footerEnd}
          </FooterRow>
        </>
      )}
    </Command>
  );
}
