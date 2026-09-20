import { Copy as CopyIcon, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCarryOverListing } from "@/hooks/projects/useCarryOverListing";
import type { CarryOverEntry } from "@shared/schemas";
import { OnlyInWorktrees } from "./OnlyInWorktrees";
import { PathPickerModal } from "@/components/shared/PathPickerModal";

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
  return (
    <PathPickerModal
      rootPath={projectPath}
      useListing={(relative) => useCarryOverListing(projectId, relative)}
      renderProvenance={(entry) => (
        <OnlyInWorktrees
          inPrimary={entry.inPrimary}
          worktrees={entry.worktrees}
          className="max-w-40"
        />
      )}
      renderTrailing={(entry, path) =>
        selectedPaths.has(path) ? (
          <span className="px-2 text-2xs text-muted-foreground">Added</span>
        ) : isCovered(path) ? (
          <span
            className="px-2 text-2xs text-amber-600 dark:text-amber-400"
            title=".worktreeinclude already copies this path into every new worktree."
          >
            covered
          </span>
        ) : entry.ignored ? (
          <div
            className="inline-flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onPick({ path, mode: "symlink" })}
              title="Edits stay in sync with the main checkout"
            >
              <LinkIcon />
              Symlink
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onPick({ path, mode: "copy" })}
              title="Independent snapshot at worktree creation"
            >
              <CopyIcon />
              Copy
            </Button>
          </div>
        ) : (
          <span
            className="px-2 text-2xs text-muted-foreground/70"
            title="Tracked by git. Only ignored files and folders can be carried over."
          >
            tracked
          </span>
        )
      }
      onClose={onClose}
    />
  );
}
