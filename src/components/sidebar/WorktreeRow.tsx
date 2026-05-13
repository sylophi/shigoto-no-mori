import { cn } from "@/lib/utils";
import { useSelection } from "@/hooks/useSelection";
import type { Worktree } from "@shared/types";

interface WorktreeRowProps {
  worktree: Worktree;
}

export function WorktreeRow({ worktree }: WorktreeRowProps) {
  const { selectedWorktreeId, selectWorktree } = useSelection();
  const isSelected = selectedWorktreeId === worktree.id;

  return (
    <button
      type="button"
      onClick={() => selectWorktree(worktree.id)}
      className={cn(
        "group relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        "hover:bg-accent/60",
        isSelected && "bg-accent text-accent-foreground",
      )}
    >
      {isSelected && (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-r-full bg-foreground"
        />
      )}
      <span className="flex-1 truncate font-medium">
        {worktree.branch.replace(/^.*\//, "")}
      </span>
      <StatusIndicator worktree={worktree} />
    </button>
  );
}

function StatusIndicator({ worktree }: { worktree: Worktree }) {
  const parts: string[] = [];
  if (worktree.ahead > 0) parts.push(`↑${worktree.ahead}`);
  if (worktree.behind > 0) parts.push(`↓${worktree.behind}`);
  if (worktree.dirtyCount > 0) parts.push(`●${worktree.dirtyCount}`);

  if (parts.length === 0) {
    return null;
  }

  return (
    <span className="tabular text-xs text-muted-foreground">
      {parts.join(" ")}
    </span>
  );
}
