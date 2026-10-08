import { only } from "@shared/util/only";
import { RefreshCw } from "lucide-react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { IconButton } from "@/components/ui/icon-button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useDelayedFlag } from "@/hooks/ui/useDelayedFlag";
import { useProjectGitFetching } from "@/hooks/git/useProjectGitFetching";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shigomori/contracts/schemas";

// The page's one refresh, in the header's top row. It spins through
// whatever the page is waiting on (a ref fetch, the worktree or branch
// lists, the PR), the automatic ones included, and says which in its
// tooltip (idle, the icon says enough). A click fetches the project's
// refs, as opening the page does and only on this device, and re-asks
// GitHub for the PR: the page refetches on focus and when refs move,
// but checks finishing or mergeability moving on GitHub's side reach
// none of that. Always there, so nothing beside it in the row moves
// when it starts or stops.
export function WorktreeActivityIndicator({
  worktree,
}: {
  worktree: Worktree;
}) {
  const queryClient = useQueryClient();
  const { api, keys, remote } = useHostScope();
  const label = useActivityLabel(worktree);
  const spinning = useDelayedFlag(label !== null);
  const tip = spinning ? label : null;
  const refresh = () => {
    // A peer's lists stay fresh through push invalidation and the
    // sweep, and the fetch is a mutating call it may refuse: there the
    // click re-asks for the PR alone. A failed fetch leaves the lists
    // as they were, which the next sweep catches up.
    if (!remote) {
      api.git
        .refreshProject({ projectId: worktree.projectId })
        .catch(() => undefined);
    }
    if (!worktree.detached) {
      void queryClient.invalidateQueries(
        {
          queryKey: keys.worktreePullRequest(
            worktree.projectId,
            worktree.branch,
          ),
          exact: true,
        },
        { cancelRefetch: false },
      );
    }
  };
  return (
    <SimpleTooltip tip={tip}>
      <IconButton
        onClick={refresh}
        aria-label={tip ?? "Refresh"}
        className="-my-1 text-muted-foreground/70"
      >
        <RefreshCw
          aria-hidden
          className={cn("size-3.5", spinning && "animate-spin")}
        />
      </IconButton>
    </SimpleTooltip>
  );
}

function useActivityLabel(worktree: Worktree): string | null {
  const { keys } = useHostScope();
  const branchesFetching = useIsFetching({
    queryKey: keys.branches(worktree.projectId),
  });
  const worktreesFetching = useIsFetching({
    queryKey: keys.worktrees(worktree.projectId),
  });
  const pullRequestFetching = useIsFetching({
    queryKey: keys.worktreePullRequest(worktree.projectId, worktree.branch),
    exact: true,
  });
  const gitFetching = useProjectGitFetching(worktree.projectId);

  // Priority order matches the order users care about: the project-
  // wide fetch is the most "happening", then per-worktree state, then
  // the PR and branches. When more than one is in flight, drop the
  // specificity and just say "Refreshing…".
  const active: string[] = [];
  if (gitFetching) active.push("Fetching refs…");
  if (worktreesFetching > 0) active.push("Refreshing worktree state…");
  if (pullRequestFetching > 0) active.push("Refreshing the pull request…");
  if (branchesFetching > 0) active.push("Refreshing branches…");

  if (active.length === 0) return null;
  return only(active) ?? "Refreshing…";
}
