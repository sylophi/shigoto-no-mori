import { useCarryOverListing } from "@/hooks/projects/useCarryOverListing";
import type {
  CarryOverCandidate,
  CarryOverEntry,
} from "@shigomori/contracts/schemas";
import { OnlyInWorktreesView } from "@shigomori/ui/views/configure/OnlyInWorktreesView.tsx";
import {
  PathPickerModal,
  usePathSteps,
} from "@/components/shared/PathPickerModal";
import { CarryOverTrailingView } from "@shigomori/ui/views/configure/CarryOverTrailingView.tsx";

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
  const steps = usePathSteps<CarryOverCandidate>();
  const listing = useCarryOverListing(projectId, steps.relative);
  return (
    <PathPickerModal
      rootPath={projectPath}
      steps={steps}
      listing={listing}
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
