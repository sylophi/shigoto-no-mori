import type { KeyboardEvent, ReactNode, Ref } from "react";
import { FolderGit2, FolderSearch } from "lucide-react";
import type { BrowseListing } from "../../lib/browseListing.ts";
import { Button } from "../../primitives/button.tsx";
import { ChipButton } from "../../primitives/chip-button.tsx";
import { FileManagerIcon } from "../../primitives/file-manager.tsx";
import { PathBrowserView } from "../shared/PathBrowserView.tsx";

// The add-existing tab's browse stage: the path as typed, the folders
// it lists, each repo among them addable, and the way to scan the
// folder for repos (AddExistingForm.tsx runs the adds, the scan and the
// keys).
export function AddExistingFormView({
  query,
  onQuery,
  inputRef,
  onInputKeyDown,
  highlighted,
  onHighlight,
  browse,
  registeredNames,
  targetIsGitRepo,
  canPrimary,
  pending,
  onPrimary,
  canBrowseUp,
  onAdd,
  terrierOptIn,
  onPickFolder,
  confirmKeys,
}: {
  // The input value IS the path.
  query: string;
  onQuery: (query: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  highlighted: string;
  onHighlight: (value: string) => void;
  browse: BrowseListing;
  // The listed folders already added as projects.
  registeredNames: ReadonlySet<string>;
  // What ↩ does: add the repo typed, or scan the folder for repos.
  targetIsGitRepo: boolean;
  canPrimary: boolean;
  pending: boolean;
  onPrimary: () => void;
  canBrowseUp: boolean;
  onAdd: (path: string) => void;
  // The terrier switch, for a project terrier should list too.
  terrierOptIn: ReactNode;
  // The native folder dialog, this machine's alone: null on a peer.
  onPickFolder: (() => void) | null;
  // The keys that add what is typed past a highlighted row (the
  // keymap's).
  confirmKeys: string;
}) {
  const submitLabel = targetIsGitRepo ? "Add" : "Scan for repos in folder";

  return (
    <PathBrowserView
      label="Add project"
      placeholder="Folder path"
      query={query}
      onQuery={onQuery}
      inputRef={inputRef}
      onInputKeyDown={onInputKeyDown}
      highlighted={highlighted}
      onHighlight={onHighlight}
      browse={browse}
      canBrowseUp={canBrowseUp}
      primary={{
        label: (
          <>
            {targetIsGitRepo ? (
              <FolderGit2 className="size-3.5" />
            ) : (
              <FolderSearch className="size-3.5" />
            )}
            {pending && targetIsGitRepo ? "Adding…" : submitLabel}
          </>
        ),
        disabled: !canPrimary || pending,
        onClick: onPrimary,
      }}
      confirmKeys={confirmKeys}
      renderIcon={(entry) =>
        entry.isGitRepo ? (
          <FolderGit2 className="size-4 text-foreground" />
        ) : undefined
      }
      renderTrailing={(entry, path) =>
        entry.isGitRepo &&
        (registeredNames.has(entry.name) ? (
          <span className="text-xs text-muted-foreground/80">Added</span>
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
              onClick={() => onAdd(path)}
            >
              Add
            </Button>
          </div>
        ))
      }
      footerEnd={
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
      }
    />
  );
}
