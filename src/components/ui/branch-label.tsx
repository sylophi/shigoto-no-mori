import { cn } from "@/lib/utils";

interface BranchLabelProps {
  branch: string;
  detached: boolean;
  // Override the suffix size when the parent text is much larger or
  // smaller than the default; otherwise the "(detached)" suffix inherits
  // the parent's font size.
  suffixClassName?: string;
}

// Renders a branch name with a muted "(detached)" suffix when HEAD is
// detached. The parent owns the wrapping element, its classes, and any
// tooltip — this component just keeps the detached affordance uniform.
export function BranchLabel({
  branch,
  detached,
  suffixClassName,
}: BranchLabelProps) {
  return (
    <>
      {branch}
      {detached && (
        <span
          className={cn(
            "ml-1 font-sans font-normal text-muted-foreground",
            suffixClassName,
          )}
        >
          (detached)
        </span>
      )}
    </>
  );
}

export function branchTooltip(worktree: { detached: boolean; branch: string }) {
  return worktree.detached ? "Detached HEAD (commit hash)" : worktree.branch;
}
