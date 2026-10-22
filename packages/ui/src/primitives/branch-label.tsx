import { cn } from "../lib/utils.ts";

interface BranchLabelProps {
  branch: string;
  detached: boolean;
  // While detached to replay a rebase: the branch it replays, drawn in
  // the hash's place.
  rebasing?: string | undefined;
  // Override the suffix size when the parent text is much larger or
  // smaller than the default; otherwise the "(detached)" suffix inherits
  // the parent's font size.
  suffixClassName?: string;
}

// Renders a branch name with a muted "(detached)" suffix when HEAD is
// detached, or "(rebasing)" when that's a rebase's. The parent owns the wrapping element, its classes, and any
// tooltip. This component just keeps the detached affordance uniform.
export function BranchLabel({
  branch,
  detached,
  rebasing,
  suffixClassName,
}: BranchLabelProps) {
  return (
    <>
      {rebasing ?? branch}
      {detached && (
        <span
          className={cn(
            "ml-1 font-sans font-normal text-muted-foreground",
            suffixClassName,
          )}
        >
          {rebasing === undefined ? "(detached)" : "(rebasing)"}
        </span>
      )}
    </>
  );
}
