import type { KeyboardEvent } from "react";
import { Command } from "cmdk";
import { Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChipButton } from "@/components/ui/chip-button";
import { FileManagerIcon } from "@/components/ui/file-manager";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { BrowseListing } from "@/hooks/fs/useBrowseListing";
import {
  ITEM_CLASS,
  keepFocusInInput,
  MODAL_COMMAND_CLASS,
} from "@/components/ui/cmdk-classes";
import {
  canNavigateUp,
  ensureTrailingSep,
  isAnchoredPath,
  normalizeForSubmit,
} from "@shared/projectPaths";
import { BrowseKeyHintsView, BrowseUpItemView } from "./BrowseListPartsView";

// Prefix used as the cmdk `value` for browse-list items. `hasHighlighted`
// reads it back to tell "a row is highlighted" from "nothing is".
export const BROWSE_VALUE_PREFIX = "browse:";

export interface FolderPickerProps {
  title?: string;
  confirmLabel?: string;
  // One line under the input explaining what the picked folder is for.
  // Also shown by the native dialog (its message) when Finder is used.
  hint?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

// Folder picker built on the same path-as-input pattern as the Add
// Project modal: typing a path lists the directory live, the
// list filters by the trailing leaf segment, and ↩ confirms / enters
// the highlighted entry. The dialog's content: FolderPickerModal
// holds the query and the listing, and puts it in a ModalShell.
export function FolderPickerView({
  title = "Pick a folder",
  confirmLabel = "Use this folder",
  hint,
  onPick,
  onClose,
  query,
  setQuery,
  highlighted,
  setHighlighted,
  browse,
  onOpenFinder,
}: FolderPickerProps & {
  query: string;
  setQuery: (value: string) => void;
  highlighted: string;
  setHighlighted: (value: string) => void;
  browse: BrowseListing;
  // The native dialog, this machine's window manager's: absent on a
  // peer's picker, which keeps the typed listing alone.
  onOpenFinder?: () => void;
}) {
  const {
    browseDir,
    leafFilter,
    listingEnabled,
    listing,
    isLoading,
    error,
    filtered,
    browseTo,
    browseUp,
  } = browse;

  const submitTarget = normalizeForSubmit(query);
  // The folder we'd confirm, off the listing's resolved path where
  // there is one: the listed folder itself when the input ends in "/"
  // (the user is "inside" it), and the typed name under it otherwise.
  // The listing is of that name's parent then, never the folder asked
  // for. With nothing listed it's whatever they've typed verbatim.
  const confirmTarget =
    listingEnabled && listing
      ? `${leafFilter ? ensureTrailingSep(listing.path) : listing.path}${leafFilter}`
      : submitTarget;
  const canConfirm = isAnchoredPath(confirmTarget) && !error;
  const hasHighlighted = highlighted.startsWith(BROWSE_VALUE_PREFIX);

  const confirm = () => {
    if (!canConfirm) return;
    onPick(confirmTarget);
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      confirm();
      return;
    }
    if (e.key === "Enter" && !hasHighlighted) {
      e.preventDefault();
      e.stopPropagation();
      confirm();
      return;
    }
    if (e.key === "ArrowLeft" && canNavigateUp(query) && !leafFilter) {
      e.preventDefault();
      e.stopPropagation();
      browseUp();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Backspace" && query === "") {
      e.preventDefault();
      onClose();
    }
  };

  const canBrowseUp = canNavigateUp(query);
  const confirmKbd = hasHighlighted ? "⌘↩" : "↩";

  return (
    <Command
      label={title}
      loop
      shouldFilter={false}
      value={highlighted}
      onValueChange={setHighlighted}
      className={MODAL_COMMAND_CLASS}
    >
      <div
        data-slot="search-row"
        className="relative flex items-center gap-2 border-b border-border px-3 py-2"
      >
        <Command.Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- picker just opened
          autoFocus
          value={query}
          onValueChange={setQuery}
          onKeyDown={onInputKeyDown}
          placeholder="Enter a path (e.g. ~/projects/)"
          className="min-w-0 flex-1 bg-transparent py-1 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          onMouseDown={(e) => e.preventDefault()}
          onClick={confirm}
          disabled={!canConfirm}
          aria-label={`${confirmLabel} (${confirmKbd})`}
        >
          <span>{confirmLabel}</span>
          <KbdGroup className="pointer-events-none">
            <Kbd>{confirmKbd}</Kbd>
          </KbdGroup>
        </Button>
      </div>
      {hint && (
        <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {hint}
        </p>
      )}

      <Command.List
        onMouseDown={keepFocusInInput}
        className="overflow-y-auto p-2"
      >
        {canBrowseUp && <BrowseUpItemView onSelect={browseUp} />}

        {filtered.map((entry) => {
          const entryPath = `${browseDir}${entry.name}`;
          return (
            <Command.Item
              key={entry.name}
              value={`${BROWSE_VALUE_PREFIX}${entryPath}`}
              keywords={[entry.name]}
              onSelect={() => browseTo(entry.name)}
              className={ITEM_CLASS}
            >
              <Folder className="size-4 text-muted-foreground/80" />
              <SimpleTooltip whenTruncated lazy tip={entry.name}>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {entry.name}
                </span>
              </SimpleTooltip>
            </Command.Item>
          );
        })}

        {isLoading && !listing && (
          <div className="p-3 text-xs text-muted-foreground">Loading…</div>
        )}
        {!isLoading && !error && filtered.length === 0 && (
          <div className="p-3 text-center text-xs text-muted-foreground">
            {leafFilter.length > 0
              ? `No folders matching "${leafFilter}".`
              : "Empty directory."}
          </div>
        )}
        {error && (
          <div className="p-3 text-center text-xs text-muted-foreground">
            Couldn't read folder.
          </div>
        )}
      </Command.List>

      <div
        data-slot="footer-row"
        className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
      >
        <div className="flex items-center gap-3">
          <BrowseKeyHintsView enterFolder={hasHighlighted} goUp={canBrowseUp} />
        </div>
        {onOpenFinder && (
          <ChipButton onClick={onOpenFinder}>
            <FileManagerIcon />
            Open in Finder
          </ChipButton>
        )}
      </div>
    </Command>
  );
}
