import { BranchLabel } from "@/components/ui/branch-label";
import { type RowStatus, RowStatusBadge } from "@/components/ui/row-status";

interface WorktreeMoveDetailsProps {
  branch: string;
  detached: boolean;
  // Paths are pre-tildified for display; the title carries the full path
  // for hover, which the two flows compute differently.
  fromPath: string;
  fromTitle: string;
  toPath: string;
  toTitle: string;
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
  fromTitle,
  toPath,
  toTitle,
  status,
  labels,
  branchAdornment,
}: WorktreeMoveDetailsProps) {
  return (
    <>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <span
            className="min-w-0 truncate font-mono select-text"
            title={detached ? "Detached HEAD (commit hash)" : branch}
          >
            <BranchLabel branch={branch} detached={detached} />
          </span>
          {branchAdornment}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 font-mono text-xs">
          <dt className="text-muted-foreground/60">from</dt>
          <dd
            className="min-w-0 truncate text-muted-foreground select-text"
            title={fromTitle}
          >
            {fromPath}
          </dd>
          <dt className="text-muted-foreground/60">to</dt>
          <dd
            className="min-w-0 truncate text-foreground/80 select-text"
            title={toTitle}
          >
            {toPath}
          </dd>
        </dl>
        {status.kind === "error" && (
          <p className="text-xs text-destructive select-text">
            {status.message}
          </p>
        )}
      </div>
      <RowStatusBadge status={status} labels={labels} />
    </>
  );
}
