import type { KeyboardEvent } from "react";
import { ChipButton } from "../../primitives/chip-button.tsx";
import { FileManagerIcon } from "../../primitives/file-manager.tsx";
import type { BrowseListing } from "../../lib/browseListing.ts";
import { PathBrowserView } from "./PathBrowserView.tsx";

// Folder picker built on the same path-as-input pattern as the Add
// Project modal: typing a path lists the directory live, the
// list filters by the trailing leaf segment, and ↩ confirms / enters
// the highlighted entry. The dialog's content: FolderPickerModal
// holds the query, the listing and the keys, and puts it in a
// ModalShell.
export function FolderPickerView({
  title,
  confirmLabel,
  hint,
  query,
  setQuery,
  onInputKeyDown,
  highlighted,
  setHighlighted,
  browse,
  browsable,
  canBrowseUp,
  canConfirm,
  onConfirm,
  onOpenFinder,
  confirmKeys,
}: {
  title: string;
  confirmLabel: string;
  hint?: string;
  query: string;
  setQuery: (value: string) => void;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  highlighted: string;
  setHighlighted: (value: string) => void;
  browse: BrowseListing;
  browsable?: boolean;
  canBrowseUp: boolean;
  canConfirm: boolean;
  onConfirm: () => void;
  // The native dialog, this machine's window manager's: absent on a
  // peer's picker, which keeps the typed listing alone.
  onOpenFinder?: () => void;
  // The keys that pick what is typed past a highlighted row (the
  // keymap's).
  confirmKeys: string;
}) {
  return (
    <PathBrowserView
      label={title}
      placeholder="Enter a path (e.g. ~/projects/)"
      query={query}
      onQuery={setQuery}
      onInputKeyDown={onInputKeyDown}
      highlighted={highlighted}
      onHighlight={setHighlighted}
      browse={browse}
      browsable={browsable}
      canBrowseUp={canBrowseUp}
      primary={{
        label: confirmLabel,
        disabled: !canConfirm,
        onClick: onConfirm,
      }}
      confirmKeys={confirmKeys}
      hint={hint}
      footerEnd={
        onOpenFinder && (
          <ChipButton onClick={onOpenFinder}>
            <FileManagerIcon />
            Reveal in Finder
          </ChipButton>
        )
      }
    />
  );
}
