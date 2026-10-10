import { FileDiff } from "lucide-react";
import { WorktreeMoveDetailsView } from "../shared/WorktreeMoveDetailsView.tsx";
import { Checkbox } from "../../primitives/checkbox.tsx";
import { type RowStatus } from "../../primitives/row-status.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import { tildify } from "@shigomori/contracts/projectPaths";
import type { Worktree } from "@shigomori/contracts/schemas/index";
import { ToneTag } from "../../primitives/row-tag.tsx";

interface ConvertRowProps {
  worktree: Worktree;
  checked: boolean;
  status: RowStatus;
  disabled: boolean;
  proposedPath: string;
  home: string | null;
  onToggle: () => void;
}

export function ConvertRowView({
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
      <WorktreeMoveDetailsView
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
              <ToneTag tone="amber">
                <FileDiff aria-hidden className="size-3" />
                {worktree.changedCount} uncommitted
              </ToneTag>
            </SimpleTooltip>
          )
        }
      />
    </label>
  );
}
