import { RefreshCw } from "lucide-react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useDelayedFlag } from "@/hooks/ui/useDelayedFlag";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/schemas";

// Re-asks gh for this worktree's PR. The page refetches on its own when
// the window regains focus, refs move, or the sweep sees the PR change,
// and polls briefly while GitHub settles the merge state. Checks
// finishing, or mergeability moving later on, reach none of those, so
// this is the way to catch them without leaving the window. The icon
// spins through any refetch, the automatic ones included.
export function PullRequestRefreshButton({ worktree }: { worktree: Worktree }) {
  const queryClient = useQueryClient();
  const { keys } = useHostScope();
  const queryKey = keys.worktreePullRequest(
    worktree.projectId,
    worktree.branch,
  );
  const fetching = useIsFetching({ queryKey }) > 0;
  const spinning = useDelayedFlag(fetching);
  return (
    <SimpleTooltip tip="Refresh pull request">
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Refresh pull request"
        className="-my-1 text-muted-foreground/70 hover:text-foreground"
        onClick={() => {
          void queryClient.invalidateQueries(
            { queryKey, exact: true },
            { cancelRefetch: false },
          );
        }}
      >
        <RefreshCw aria-hidden className={cn(spinning && "animate-spin")} />
      </Button>
    </SimpleTooltip>
  );
}
