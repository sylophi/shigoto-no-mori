import { ArrowDown, Loader2 } from "lucide-react";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useSyncWithPrimaryWorktree } from "@/hooks/worktrees/useWorktreeSync";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/schemas";

interface WorktreePrimarySyncPillProps {
  worktree: Worktree;
}

// "Sync from primary": pulls the project's primary branch (usually
// origin/main) into this worktree's branch via rebase, falling back to
// merge on per-commit conflicts -- same shape as the Pull-and-push
// button for upstream divergence. Hidden when there's nothing to pull
// in (behindPrimary === 0), on detached HEAD, or on the primary
// worktree itself.
export function WorktreePrimarySyncPill({
  worktree,
}: WorktreePrimarySyncPillProps) {
  const sync = useSyncWithPrimaryWorktree();
  const { data: primaryRef } = useDefaultBranch(worktree.projectId);

  if (worktree.isPrimary || worktree.detached || worktree.behindPrimary === 0) {
    return null;
  }

  // primaryRef is resolved server-side (e.g. "origin/main"); show just
  // the branch part. The remote prefix is implementation detail, the
  // user thinks in branch names.
  const display = primaryRef
    ? primaryRef.includes("/")
      ? primaryRef.split("/").slice(1).join("/")
      : primaryRef
    : "primary";

  const Icon = sync.isPending ? Loader2 : ArrowDown;
  return (
    <button
      type="button"
      onClick={() =>
        sync.mutate({
          projectId: worktree.projectId,
          worktreeId: worktree.id,
        })
      }
      disabled={sync.isPending}
      title={`git fetch && git rebase ${primaryRef ?? "primary"}, falling back to a merge on conflict`}
      className={cn(
        "tabular inline-flex shrink-0 items-center gap-1 self-center rounded-md px-1.5 py-1 text-xs text-sky-500 transition-colors hover:bg-sky-500/10 focus-visible:outline-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      Sync {worktree.behindPrimary} from {display}
      <Icon
        aria-hidden
        className={cn("size-3.5", sync.isPending && "animate-spin")}
      />
    </button>
  );
}
