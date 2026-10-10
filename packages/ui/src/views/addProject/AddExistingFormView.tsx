import type { KeyboardEvent, ReactNode, Ref } from "react";
import { Command } from "cmdk";
import { Folder, FolderGit2, FolderSearch } from "lucide-react";
import type { BrowseListing } from "../../lib/browseListing.ts";
import { Button } from "../../primitives/button.tsx";
import { ChipButton } from "../../primitives/chip-button.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { FileManagerIcon } from "../../primitives/file-manager.tsx";
import {
  BrowseKeyHintsView,
  BrowseUpItemView,
} from "../shared/BrowseListPartsView.tsx";
import {
  ITEM_CLASS,
  keepFocusInInput,
  MODAL_COMMAND_CLASS,
} from "../../primitives/cmdk-classes.ts";
import { KeyedButtonView } from "./DialogPartsView.tsx";

// The add-existing tab's browse stage: the path as typed, the folders
// it lists, each repo among them addable, and the way to scan the
// folder for repos (AddExistingForm.tsx runs the adds and the scan).
export function AddExistingFormView({
  query,
  onQuery,
  inputRef,
  onInputKeyDown,
  highlighted,
  onHighlight,
  browseDir,
  entries,
  registeredNames,
  isLoading,
  hasListing,
  error,
  leafFilter,
  targetIsGitRepo,
  canPrimary,
  pending,
  onPrimary,
  canBrowseUp,
  onBrowseUp,
  onBrowseTo,
  onAdd,
  terrierOptIn,
  onPickFolder,
}: {
  // The input value IS the path.
  query: string;
  onQuery: (query: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  // The list row under the keyboard, "browse:<path>" for a folder.
  highlighted: string;
  onHighlight: (value: string) => void;
  // The folder listed, with its trailing slash.
  browseDir: string;
  entries: BrowseListing["filtered"];
  // The listed folders already added as projects.
  registeredNames: ReadonlySet<string>;
  isLoading: boolean;
  hasListing: boolean;
  error: unknown;
  // What follows the last slash, narrowing the folders.
  leafFilter: string;
  // What ↩ does: add the repo typed, or scan the folder for repos.
  targetIsGitRepo: boolean;
  canPrimary: boolean;
  pending: boolean;
  onPrimary: () => void;
  canBrowseUp: boolean;
  onBrowseUp: () => void;
  onBrowseTo: (name: string) => void;
  onAdd: (path: string) => void;
  // The terrier switch, for a project terrier should list too.
  terrierOptIn: ReactNode;
  // The native folder dialog, this machine's alone: null on a peer.
  onPickFolder: (() => void) | null;
}) {
  const hasHighlighted = highlighted.startsWith("browse:");
  const submitLabel = targetIsGitRepo ? "Add" : "Scan for repos in folder";
  const submitKbd = hasHighlighted ? "⌘↩" : "↩";

  return (
    <Command
      label="Add project"
      loop
      shouldFilter={false}
      value={highlighted}
      onValueChange={onHighlight}
      className={MODAL_COMMAND_CLASS}
    >
      <div
        data-slot="search-row"
        className="relative flex items-center gap-2 border-b border-border px-3 py-2"
      >
        <Command.Input
          ref={inputRef}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the input is the whole point of this flow
          autoFocus
          value={query}
          onValueChange={onQuery}
          onKeyDown={onInputKeyDown}
          placeholder="Folder path"
          className="min-w-0 flex-1 bg-transparent py-1 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
        />
        <KeyedButtonView
          icon={
            targetIsGitRepo ? (
              <FolderGit2 className="size-3.5" />
            ) : (
              <FolderSearch className="size-3.5" />
            )
          }
          label={pending && targetIsGitRepo ? "Adding…" : submitLabel}
          keys={submitKbd}
          onMouseDown={keepFocusInInput}
          onClick={onPrimary}
          disabled={!canPrimary || pending}
          aria-label={`${submitLabel} (${submitKbd})`}
        />
      </div>

      <Command.List
        onMouseDown={keepFocusInInput}
        className="overflow-y-auto p-2"
      >
        {canBrowseUp && <BrowseUpItemView onSelect={onBrowseUp} />}

        {entries.map((entry) => {
          const entryPath = `${browseDir}${entry.name}`;
          const registered = registeredNames.has(entry.name);
          return (
            <Command.Item
              key={entry.name}
              value={`browse:${entryPath}`}
              keywords={[entry.name]}
              onSelect={() => onBrowseTo(entry.name)}
              className={ITEM_CLASS}
            >
              {entry.isGitRepo ? (
                <FolderGit2 className="size-4 text-foreground" />
              ) : (
                <Folder className="size-4 text-muted-foreground/80" />
              )}
              <SimpleTooltip whenTruncated lazy tip={entry.name}>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {entry.name}
                </span>
              </SimpleTooltip>
              {entry.isGitRepo &&
                (registered ? (
                  <span className="text-xs text-muted-foreground/80">
                    Added
                  </span>
                ) : (
                  <div
                    className="inline-flex items-center"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    role="presentation"
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => onAdd(entryPath)}
                    >
                      Add
                    </Button>
                  </div>
                ))}
            </Command.Item>
          );
        })}

        {isLoading && !hasListing && (
          <div className="p-3 text-xs text-muted-foreground">Loading…</div>
        )}
        {!isLoading && !error && entries.length === 0 && (
          <div className="p-3 text-center text-xs text-muted-foreground">
            {leafFilter.length > 0
              ? `No folders matching "${leafFilter}".`
              : "Empty directory."}
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
        <div className="flex items-center gap-3">
          {terrierOptIn}
          {/* The native dialog is this machine's, so it can't pick a
              folder on a peer's disk. */}
          {onPickFolder !== null && (
            <ChipButton onClick={onPickFolder}>
              <FileManagerIcon />
              Add project from Finder
            </ChipButton>
          )}
        </div>
      </div>
    </Command>
  );
}
