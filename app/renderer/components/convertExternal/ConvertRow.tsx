import { FileDiff } from "lucide-react";
import { WorktreeMoveDetails } from "@/components/shared/WorktreeMoveDetails";
import { Checkbox } from "@/components/ui/checkbox";
import { type RowStatus } from "@/components/ui/row-status";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { tildify } from "@shared/projectPaths";
import type { Worktree } from "@shigomori/contracts/schemas";

interface ConvertRowProps {
  worktree: Worktree;
  checked: boolean;
  status: RowStatus;
  disabled: boolean;
  proposedPath: string;
  home: string | null;
  onToggle: () => void;
}

export function ConvertRow({
  worktree,
  checked,
  status,
  disabled,
  proposedPath,
  home,
  onToggle,
}: ConvertRowProps) {
  const detached = worktree.detached;
  const dirty = worktree.changedCount > 0;
  const oldPath = tildify(worktree.path, home);
  const interactive = !disabled && status.kind !== "done";

  return (
    <label
      className={cn(
        "group flex items-start gap-3 px-3 py-3 text-sm",
        disabled && "opacity-70",
        interactive && "cursor-pointer transition-colors hover:bg-accent/30",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        disabled={!interactive}
        className="mt-1"
      />
      <WorktreeMoveDetails
        branch={worktree.branch}
        detached={detached}
        fromPath={oldPath}
        fromTip={worktree.path}
        toPath={proposedPath}
        toTip={proposedPath}
        status={status}
        labels={{
          running: "Converting",
          done: "Converted",
          error: "Conversion failed",
        }}
        branchAdornment={
          dirty && (
            <SimpleTooltip tip="Uncommitted changes will be wiped">
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-3xs font-medium text-amber-600 dark:text-amber-400">
                <FileDiff aria-hidden className="size-3" />
                {worktree.changedCount} uncommitted
              </span>
            </SimpleTooltip>
          )
        }
      />
    </label>
  );
}
