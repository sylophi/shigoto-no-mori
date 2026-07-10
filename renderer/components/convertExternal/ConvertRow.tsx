import { FileDiff } from "lucide-react";
import { WorktreeMoveDetails } from "@/components/shared/WorktreeMoveDetails";
import { type RowStatus } from "@/components/ui/row-status";
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
        interactive && "cursor-pointer transition-colors hover:bg-accent/30",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={!interactive}
        className="mt-1 size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
      />
      <WorktreeMoveDetails
        branch={worktree.branch}
        detached={detached}
        fromPath={oldPath}
        fromTitle={worktree.path}
        toPath={proposedPath}
        toTitle={proposedPath}
        status={status}
        labels={{
          running: "Converting",
          done: "Converted",
          error: "Conversion failed",
        }}
        branchAdornment={
          dirty && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              title="Uncommitted changes will be wiped"
            >
              <FileDiff aria-hidden className="size-3" />
              {worktree.changedCount} uncommitted
            </span>
          )
        }
      />
    </label>
  );
}
