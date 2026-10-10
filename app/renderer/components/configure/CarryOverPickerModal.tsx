import { useCarryOverListing } from "@/hooks/projects/useCarryOverListing";
import type { CarryOverEntry } from "@shigomori/contracts/schemas";
import { OnlyInWorktreesView } from "./OnlyInWorktreesView";
import { PathPickerModal } from "@/components/shared/PathPickerModal";
import { CarryOverTrailingView } from "./CarryOverTrailingView";

interface CarryOverPickerModalProps {
  projectId: string;
  projectPath: string;
  selectedPaths: Set<string>;
  // True when .worktreeinclude already copies the path into every new
  // worktree, so offering a manual entry would be futile (it gets
  // auto-removed at the next creation).
  isCovered: (relative: string) => boolean;
  onPick: (entry: CarryOverEntry) => void;
  onClose: () => void;
}

// The carry-over picker: the shared folder browser over the union of
// every checkout, each ignored row offering Symlink and Copy.
export function CarryOverPickerModal({
  projectId,
  projectPath,
  selectedPaths,
  isCovered,
  onPick,
  onClose,
}: CarryOverPickerModalProps) {
  const useListing = (relative: string) =>
    useCarryOverListing(projectId, relative);
  return (
    <PathPickerModal
      rootPath={projectPath}
      useListing={useListing}
      renderProvenance={(entry) => (
        <OnlyInWorktreesView
          inPrimary={entry.inPrimary}
          worktrees={entry.worktrees}
          className="max-w-40"
        />
      )}
      renderTrailing={(entry, path) => (
        <CarryOverTrailingView
          added={selectedPaths.has(path)}
          covered={isCovered(path)}
          ignored={entry.ignored}
          onPick={(mode) => onPick({ path, mode })}
        />
      )}
      onClose={onClose}
    />
  );
}
