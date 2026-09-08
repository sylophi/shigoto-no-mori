import { Checkbox } from "@/components/ui/checkbox";
import type { ChangedFile } from "@shared/schemas";
import { changedFilePaths } from "./changesControls";

// A file's tick, shared by the rail row and the diff file header so the
// two read and behave the same. Partial (hunks staged from a terminal)
// draws as a dash and ticks to the whole file.
export function StagedCheckbox({
  file,
  disabled,
  onSetStaged,
  className,
}: {
  file: ChangedFile;
  disabled: boolean;
  onSetStaged: (paths: string[], staged: boolean) => void;
  className?: string;
}) {
  const ticked = file.staged === "all";
  return (
    <Checkbox
      checked={ticked}
      indeterminate={file.staged === "partial"}
      disabled={disabled}
      onCheckedChange={(next) => onSetStaged(changedFilePaths(file), next)}
      aria-label={
        ticked
          ? `Leave ${file.path} out of the commit`
          : `Include ${file.path} in the commit`
      }
      title={
        file.staged === "partial"
          ? "Partly staged: tick to include the whole file"
          : ticked
            ? "Included in the commit"
            : "Not included in the commit"
      }
      className={className}
    />
  );
}
