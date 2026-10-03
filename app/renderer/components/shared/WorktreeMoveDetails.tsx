import { BranchLabel } from "@/components/ui/branch-label";
import { type RowStatus, RowStatusBadge } from "@/components/ui/row-status";
import { InlineError } from "@/components/ui/inline-error";
import { SimpleTooltip } from "@/components/ui/tooltip";

interface WorktreeMoveDetailsProps {
  branch: string;
  detached: boolean;
  // Paths are pre-tildified for display; the tip carries the full path
  // for hover, which the two flows compute differently.
  fromPath: string;
  fromTip: string;
  toPath: string;
  toTip: string;
  status: RowStatus;
  labels: { running: string; done: string; error: string };
  // Rendered next to the branch label (e.g. the convert flow's
  // "uncommitted changes" badge).
  branchAdornment?: React.ReactNode;
}

// Shared body for the convert-external and relocate rows: a branch label,
// a from/to path grid, and an inline error line, trailed by the status
// badge. The surrounding row (checkbox, wrapper element) stays with each
// flow since those genuinely differ.
export function WorktreeMoveDetails({
  branch,
  detached,
  fromPath,
  fromTip,
  toPath,
  toTip,
  status,
  labels,
  branchAdornment,
}: WorktreeMoveDetailsProps) {
  return (
    <>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <SimpleTooltip whenTruncated tip={branch}>
            <span className="min-w-0 truncate font-mono select-text">
              <BranchLabel branch={branch} detached={detached} />
            </span>
          </SimpleTooltip>
          {branchAdornment}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 font-mono text-xs">
          <dt className="text-muted-foreground/60">from</dt>
          <SimpleTooltip whenTruncated tip={fromTip}>
            <dd className="min-w-0 truncate text-muted-foreground select-text">
              {fromPath}
            </dd>
          </SimpleTooltip>
          <dt className="text-muted-foreground/60">to</dt>
          <SimpleTooltip whenTruncated tip={toTip}>
            <dd className="min-w-0 truncate text-foreground/80 select-text">
              {toPath}
            </dd>
          </SimpleTooltip>
        </dl>
        {status.kind === "error" && (
          <InlineError
            message={status.message}
            title="Couldn't move the worktree"
            className="text-xs text-destructive"
          />
        )}
      </div>
      <RowStatusBadge status={status} labels={labels} />
    </>
  );
}
