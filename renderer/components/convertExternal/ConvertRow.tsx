import { FileDiff } from "lucide-react";
import { BranchLabel } from "@/components/ui/branch-label";
import { type RowStatus, RowStatusBadge } from "@/components/ui/row-status";
import { cn } from "@/lib/utils";
import { tildify } from "@/lib/projectPaths";
import type { Worktree } from "@shared/schemas";

interface ConvertRowProps {
  worktree: Worktree;
  checked: boolean;
  status: RowStatus;
  disabled: boolean;
  indeterminateHeader: boolean;
  proposedPath: string;
  home: string | null;
  onToggle: () => void;
  isLast: boolean;
}

export function ConvertRow({
  worktree,
  checked,
  status,
  disabled,
  proposedPath,
  home,
  onToggle,
  isLast,
}: ConvertRowProps) {
  const detached = worktree.detached;
  const dirty = worktree.changedCount > 0;
  const oldPath = tildify(worktree.path, home);
  const interactive = !disabled && status.kind !== "done";

  return (
    <label
      className={cn(
        "group flex items-start gap-3 px-3 py-3 text-sm",
        !isLast && "border-b border-border",
        disabled && "opacity-70",
        interactive && "cursor-pointer",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={!interactive}
        className="mt-1 size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <span
            className="min-w-0 truncate font-mono select-text"
            title={detached ? "Detached HEAD (commit hash)" : worktree.branch}
          >
            <BranchLabel branch={worktree.branch} detached={detached} />
          </span>
          {dirty && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              title="Uncommitted changes will be wiped"
            >
              <FileDiff aria-hidden className="size-3" />
              {worktree.changedCount} uncommitted
            </span>
          )}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 font-mono text-xs">
          <dt className="text-muted-foreground/60">from</dt>
          <dd
            className="min-w-0 truncate text-muted-foreground select-text"
            title={worktree.path}
          >
            {oldPath}
          </dd>
          <dt className="text-muted-foreground/60">to</dt>
          <dd
            className="min-w-0 truncate text-foreground/80 select-text"
            title={proposedPath}
          >
            {proposedPath}
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
        labels={{
          running: "Converting",
          done: "Converted",
          error: "Conversion failed",
        }}
      />
    </label>
  );
}
