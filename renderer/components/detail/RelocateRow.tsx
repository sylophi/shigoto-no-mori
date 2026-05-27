import { BranchLabel } from "@/components/ui/branch-label";
import { type RowStatus, RowStatusBadge } from "@/components/ui/row-status";
import { cn } from "@/lib/utils";
import { tildify } from "@/lib/projectPaths";
import type { Worktree } from "@shared/schemas";

interface RelocateRowProps {
  worktree: Worktree;
  destination: string;
  status: RowStatus;
  home: string | null;
  isLast: boolean;
}

export function RelocateRow({
  worktree,
  destination,
  status,
  home,
  isLast,
}: RelocateRowProps) {
  const fromPath = tildify(worktree.path, home);
  const toPath = tildify(destination, home);
  return (
    <div
      className={cn(
        "flex items-start gap-3 px-3 py-3 text-sm",
        !isLast && "border-b border-border",
      )}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <span
            className="min-w-0 truncate font-mono select-text"
            title={
              worktree.detached
                ? "Detached HEAD (commit hash)"
                : worktree.branch
            }
          >
            <BranchLabel
              branch={worktree.branch}
              detached={worktree.detached}
            />
          </span>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 font-mono text-xs">
          <dt className="text-muted-foreground/60">from</dt>
          <dd
            className="min-w-0 truncate text-muted-foreground select-text"
            title={worktree.path}
          >
            {fromPath}
          </dd>
          <dt className="text-muted-foreground/60">to</dt>
          <dd
            className="min-w-0 truncate text-foreground/80 select-text"
            title={destination}
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
      <RowStatusBadge
        status={status}
        labels={{ running: "Moving", done: "Moved", error: "Move failed" }}
      />
    </div>
  );
}
