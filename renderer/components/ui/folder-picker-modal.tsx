import { useState, type KeyboardEvent } from "react";
import { Command } from "cmdk";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CornerLeftUp,
  Folder,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChipButton } from "@/components/ui/chip-button";
import { FileManagerIcon } from "@/components/ui/file-manager";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ModalShell } from "@/components/ui/modal-shell";
import { useFsListDirectory } from "@/hooks/fs/useFsListDirectory";
import { notifyError } from "@/lib/toast";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  ensureTrailingSep,
  getBrowseDirectoryPath,
  getBrowseLeafSegment,
  getBrowseParentPath,
  hasTrailingSlash,
  normalizeForSubmit,
} from "@/lib/projectPaths";

// Prefix used as the cmdk `value` for browse-list items. `hasHighlighted`
// reads it back to tell "a row is highlighted" from "nothing is".
const BROWSE_VALUE_PREFIX = "browse:";

interface FolderPickerModalProps {
  initialPath?: string;
  title?: string;
  confirmLabel?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

// Folder picker built on the same path-as-input pattern as the Add
// Project modal: typing a path lists the directory live, the
// list filters by the trailing leaf segment, and ↩ confirms / enters
// the highlighted entry.
export function FolderPickerModal({
  initialPath,
  title = "Pick a folder",
  confirmLabel = "Use this folder",
  onPick,
  onClose,
}: FolderPickerModalProps) {
  // Seed the input value with the caller's path; otherwise drop into ~/.
  // When an initialPath is provided we append a separator (matching the
  // path's own style) so the listing fires immediately rather than
  // treating the basename as a leaf filter.
  const seed = initialPath ? ensureTrailingSep(initialPath) : "~/";
  const [query, setQuery] = useState<string>(seed);
  const [highlighted, setHighlighted] = useState<string>("");

  const browseDir = getBrowseDirectoryPath(query);
  const leafFilter = hasTrailingSlash(query) ? "" : getBrowseLeafSegment(query);
  const listingEnabled = browseDir.length > 0 && hasTrailingSlash(browseDir);
  const {
    data: listing,
    isLoading,
    error,
  } = useFsListDirectory(browseDir, listingEnabled);

  const filtered = (listing?.entries ?? []).filter((e) =>
    e.name.toLowerCase().startsWith(leafFilter.toLowerCase()),
  );

  const browseTo = (name: string) => {
    setQuery(appendBrowsePathSegment(query, name));
    setHighlighted("");
  };

  const browseUp = () => {
    const parent = getBrowseParentPath(query);
    if (parent) {
      setQuery(parent);
      setHighlighted("");
    }
  };

  const submitTarget = normalizeForSubmit(query);
  // The folder we'd confirm is the resolved listing path when the input
  // ends in "/" (so the user is "inside" that folder); otherwise it's
  // whatever they've typed verbatim.
  const confirmTarget = listingEnabled
    ? (listing?.path ?? submitTarget)
    : submitTarget;
  const canConfirm = confirmTarget.length > 0 && !error;
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
    // Escape is owned by the Command.Input handler so it can also exit
    // typeahead state; let the input swallow it before the shell sees it.
    <ModalShell onClose={onClose} closeOnEscape={false}>
      <Command
        label={title}
        loop
        shouldFilter={false}
        value={highlighted}
        onValueChange={setHighlighted}
      >
        <div className="relative flex items-center gap-2 border-b border-border px-3 py-2">
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
            title={`${confirmLabel} (${confirmKbd})`}
          >
            <span>{confirmLabel}</span>
            <KbdGroup className="pointer-events-none">
              <Kbd>{confirmKbd}</Kbd>
            </KbdGroup>
          </Button>
        </div>

        <Command.List className="max-h-96 overflow-y-auto p-2">
          {canBrowseUp && (
            <Command.Item
              value={`${BROWSE_VALUE_PREFIX}up`}
              keywords={[".."]}
              onSelect={browseUp}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <CornerLeftUp className="size-4 text-muted-foreground/80" />
              <span className="font-mono text-muted-foreground">..</span>
            </Command.Item>
          )}

          {filtered.map((entry) => {
            const entryPath = `${browseDir}${entry.name}`;
            return (
              <Command.Item
                key={entry.name}
                value={`${BROWSE_VALUE_PREFIX}${entryPath}`}
                keywords={[entry.name]}
                onSelect={() => browseTo(entry.name)}
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
              >
                <Folder className="size-4 text-muted-foreground/80" />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {entry.name}
                </span>
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

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <KbdGroup>
              <Kbd>
                <ArrowUp />
              </Kbd>
              <Kbd>
                <ArrowDown />
              </Kbd>
              <span className="text-muted-foreground/80">Navigate</span>
            </KbdGroup>
            {hasHighlighted && (
              <KbdGroup>
                <Kbd>↩</Kbd>
                <span className="text-muted-foreground/80">Enter folder</span>
              </KbdGroup>
            )}
            {canBrowseUp && (
              <KbdGroup>
                <Kbd>
                  <ArrowLeft />
                </Kbd>
                <span className="text-muted-foreground/80">Go up</span>
              </KbdGroup>
            )}
          </div>
          <ChipButton
            onClick={async () => {
              let picked: string | null;
              try {
                picked = await window.api.dialog.pickFolder({
                  title,
                  buttonLabel: confirmLabel,
                });
              } catch (err) {
                // Cancelling resolves to null, so a rejection is a real
                // dialog/IPC failure.
                notifyError("Couldn't open the folder picker", err);
                return;
              }
              if (picked) onPick(picked);
            }}
          >
            <FileManagerIcon />
            Open in Finder
          </ChipButton>
        </div>
      </Command>
    </ModalShell>
  );
}
