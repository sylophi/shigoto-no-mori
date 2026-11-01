// The folder picker (FolderPickerView) in a modal, over the scope's
// disk: browsing a peer's works the same as this one's.
import { useState, type KeyboardEvent } from "react";
import { FolderPickerView } from "@shigomori/ui/views/shared/FolderPickerView.tsx";
import { isBrowseRow } from "@shigomori/ui/views/shared/PathBrowserView.tsx";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { useBrowseListing } from "@/hooks/fs/useBrowseListing";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useBinding } from "@/hooks/ui/useKeymap";
import { notifyError } from "@/lib/toast";
import {
  canNavigateUp,
  ensureTrailingSep,
  isAnchoredPath,
  normalizeForSubmit,
} from "@shigomori/contracts/projectPaths";
import { useApi } from "@/lib/runtime/pageApi";

export function FolderPickerModal({
  initialPath,
  title = "Pick a folder",
  confirmLabel = "Use this folder",
  hint,
  onPick,
  onClose,
}: {
  initialPath?: string;
  title?: string;
  confirmLabel?: string;
  // One line under the input explaining what the picked folder is for.
  // Also shown by the native dialog (its message) when Finder is used.
  hint?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const confirmKeys = useBinding("confirm");
  // Seed the input value with the caller's path, otherwise drop into ~/.
  // When an initialPath is provided we append a separator (matching the
  // path's own style) so the listing fires immediately rather than
  // treating the basename as a leaf filter.
  const seed = initialPath ? ensureTrailingSep(initialPath) : "~/";
  const [query, setQuery] = useState<string>(seed);
  // The native dialog is this machine's window manager: it can only
  // ever pick a path here.
  const { remote } = useHostScope();
  const [highlighted, setHighlighted] = useState<string>("");
  const browse = useBrowseListing({ query, setQuery, setHighlighted });
  const { listingEnabled, listing, leafFilter, error } = browse;

  // The folder we'd confirm, off the listing's resolved path where
  // there is one: the listed folder itself when the input ends in "/"
  // (the user is "inside" it), and the typed name under it otherwise.
  // The listing is of that name's parent then, never the folder asked
  // for. With nothing listed it's whatever they've typed verbatim.
  const confirmTarget =
    listingEnabled && listing
      ? `${leafFilter ? ensureTrailingSep(listing.path) : listing.path}${leafFilter}`
      : normalizeForSubmit(query);
  const canConfirm = isAnchoredPath(confirmTarget) && !error;
  const canBrowseUp = canNavigateUp(query);

  const confirm = () => {
    if (!canConfirm) return;
    onPick(confirmTarget);
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (
      confirmKeys.matches(e) ||
      (e.key === "Enter" && !isBrowseRow(highlighted))
    ) {
      e.preventDefault();
      e.stopPropagation();
      confirm();
      return;
    }
    if (e.key === "ArrowLeft" && canBrowseUp && !leafFilter) {
      e.preventDefault();
      e.stopPropagation();
      browse.browseUp();
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

  const openFinder = async () => {
    // Open Finder where the picker is, not at ~.
    const defaultPath = listing?.path;
    let picked: string | null;
    try {
      picked = await api.run(
        api.dialog.pickFolder({
          title,
          buttonLabel: confirmLabel,
          message: hint,
          defaultPath,
        }),
      );
    } catch (err) {
      // Cancelling resolves to null, so a rejection is a real
      // dialog/IPC failure.
      notifyError("Couldn't open the folder picker", err);
      return;
    }
    if (picked) onPick(picked);
  };

  return (
    // Escape is owned by the input's handler above so it can also exit
    // typeahead state. The input swallows it before the shell sees it.
    <ModalShell label={title} onClose={onClose} closeOnEscape={false}>
      <FolderPickerView
        title={title}
        confirmLabel={confirmLabel}
        hint={hint}
        query={query}
        setQuery={setQuery}
        onInputKeyDown={onInputKeyDown}
        highlighted={highlighted}
        setHighlighted={setHighlighted}
        browse={browse}
        canBrowseUp={canBrowseUp}
        canConfirm={canConfirm}
        onConfirm={confirm}
        onOpenFinder={remote ? undefined : () => void openFinder()}
        confirmKeys={confirmKeys.label}
      />
    </ModalShell>
  );
}
