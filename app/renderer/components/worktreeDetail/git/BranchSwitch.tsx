import { useRef, useState } from "react";
import { ChevronsUpDown, GitBranch, TriangleAlert } from "lucide-react";
import { BranchLabel } from "@/components/ui/branch-label";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/schemas";
import { BranchSwitcher } from "../branch/BranchSwitcher";

// The head of the Git page's sidebar: the branch, which is also the way
// to another, since in a git client the branch is something you pick.
export function BranchSwitch({ worktree }: { worktree: Worktree }) {
  const { detached } = worktree;
  const Icon = detached ? TriangleAlert : GitBranch;
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div ref={anchorRef} className="flex min-w-0 items-center">
      <SimpleTooltip
        tip={
          detached
            ? "HEAD is on a commit, not a branch: new commits here belong to no branch"
            : "Switch branch"
        }
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Branch ${worktree.branch}, switch branch`}
          className="-mx-1.5 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Icon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0",
              detached ? "text-amber-500" : "text-muted-foreground",
            )}
          />
          <span className="min-w-0 truncate font-mono text-xs">
            <BranchLabel branch={worktree.branch} detached={detached} />
          </span>
          <ChevronsUpDown
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/60"
          />
        </button>
      </SimpleTooltip>
      <BranchSwitcher
        worktree={worktree}
        anchorRef={anchorRef}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
