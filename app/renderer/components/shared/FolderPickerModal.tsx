// The folder picker (FolderPickerView) in a modal, over the scope's
// disk: browsing a peer's works the same as this one's.
import { useState } from "react";
import {
  FolderPickerView,
  type FolderPickerProps,
} from "@shigomori/ui/views/shared/FolderPickerView.tsx";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { useBrowseListing } from "@/hooks/fs/useBrowseListing";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { notifyError } from "@/lib/toast";
import { ensureTrailingSep } from "@shigomori/contracts/projectPaths";

export function FolderPickerModal({
  initialPath,
  title = "Pick a folder",
  confirmLabel = "Use this folder",
  ...props
}: Partial<Pick<FolderPickerProps, "title" | "confirmLabel">> &
  Omit<FolderPickerProps, "title" | "confirmLabel"> & {
    initialPath?: string;
  }) {
  const { hint, onPick, onClose } = props;
  // Seed the input value with the caller's path; otherwise drop into ~/.
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

  const openFinder = async () => {
    let picked: string | null;
    try {
      picked = await window.api.dialog.pickFolder({
        title,
        buttonLabel: confirmLabel,
        message: hint,
        // Open Finder where the picker is, not at ~.
        defaultPath: browse.listing?.path,
      });
    } catch (err) {
      // Cancelling resolves to null, so a rejection is a real
      // dialog/IPC failure.
      notifyError("Couldn't open the folder picker", err);
      return;
    }
    if (picked) onPick(picked);
  };

  return (
    // Escape is owned by the Command.Input handler so it can also exit
    // typeahead state; let the input swallow it before the shell sees it.
    <ModalShell label={title} onClose={onClose} closeOnEscape={false}>
      <FolderPickerView
        {...props}
        title={title}
        confirmLabel={confirmLabel}
        query={query}
        setQuery={setQuery}
        highlighted={highlighted}
        setHighlighted={setHighlighted}
        browse={browse}
        onOpenFinder={remote ? undefined : () => void openFinder()}
      />
    </ModalShell>
  );
}
