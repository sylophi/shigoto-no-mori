import { ChevronRight, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useAbortOperation,
  useContinueOperation,
  useWorktreeOperation,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/schemas";

const STOPPED: Record<string, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
  "git am": "git am",
  bisect: "Bisect",
  "cherry-pick or revert": "Cherry-pick",
};

// A merge, rebase, cherry-pick or revert the worktree is stopped in,
// from the app or a terminal, or conflicts a stash left behind. Shown on
// the worktree page's Git section, where Resolve leads to the Git page,
// and atop the Git page's Changes tab, where the conflicted files are
// settled. Once none is left, the operation can be continued. Nothing
// while the worktree is in none.
export function OperationBanner({
  worktree,
  onGitPage = false,
}: {
  worktree: Worktree;
  onGitPage?: boolean;
}) {
  const nav = useWorktreeNav();
  const { data: state } = useWorktreeOperation(worktree);
  const proceed = useContinueOperation();
  const abort = useAbortOperation();
  if (!state || (state.operation === null && state.conflicted === 0)) {
    return null;
  }
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  const busy = proceed.isPending || abort.isPending;
  const title =
    state.operation === null
      ? "Conflicts in the working tree"
      : `${STOPPED[state.operation] ?? state.operation} stopped`;
  const detail =
    state.conflicted > 0
      ? `${pluralize(state.conflicted, "file")} to resolve`
      : "every conflict resolved";
  // On the Git page's narrow sidebar the detail drops under the title
  // and the moves stay beside them, two lines in all.
  return (
    <div
      className={cn(
        "flex items-center rounded-lg bg-amber-500/10",
        onGitPage
          ? "gap-2 px-2 py-1.5 text-xs"
          : "flex-wrap gap-x-3 gap-y-1.5 px-3 py-2 text-sm",
      )}
    >
      <TriangleAlert
        aria-hidden
        className={cn(
          "shrink-0 text-amber-500",
          onGitPage ? "size-3.5" : "size-4",
        )}
      />
      <div className={cn("min-w-0 flex-1", !onGitPage && "basis-40")}>
        {onGitPage ? (
          <>
            <div className="truncate">{title}</div>
            <div className="truncate text-muted-foreground">{detail}</div>
          </>
        ) : (
          <>
            {title}
            <span className="ml-2 text-muted-foreground">{detail}</span>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {state.operation !== null && (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => abort.mutate(scope)}
          >
            Abort
          </Button>
        )}
        {state.conflicted === 0
          ? state.continuable && (
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={() => proceed.mutate(scope)}
              >
                Continue
              </Button>
            )
          : !onGitPage && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => nav.toDiff(worktree.projectId, worktree.id)}
              >
                Resolve
                <ChevronRight />
              </Button>
            )}
      </div>
    </div>
  );
}
