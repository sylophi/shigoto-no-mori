import { only } from "@shigomori/contracts/util/only";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useDelayedFlag } from "@/hooks/ui/useDelayedFlag";
import { useProjectGitFetching } from "@/hooks/git/useProjectGitFetching";
import type { Worktree } from "@shigomori/contracts/schemas";
import { WorktreeActivityIndicatorView } from "@shigomori/ui/views/worktreeDetail/WorktreeActivityIndicatorView.tsx";

// The page's one refresh (WorktreeActivityIndicatorView), spinning
// through whatever the page is waiting on.
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
    // A peer's lists are its host's views, which follow its fetches,
    // and the fetch is a mutating call it may refuse: there the click
    // re-asks for the PR alone. A failed fetch leaves the lists
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
    <WorktreeActivityIndicatorView
      tip={tip}
      spinning={spinning}
      onRefresh={refresh}
    />
  );
}

function useActivityLabel(worktree: Worktree): string | null {
  const { keys } = useHostScope();
  const branchesFetching = useIsFetching({
    queryKey: keys.branches(worktree.projectId),
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
  if (pullRequestFetching > 0) active.push("Refreshing the pull request…");
  if (branchesFetching > 0) active.push("Refreshing branches…");

  if (active.length === 0) return null;
  return only(active) ?? "Refreshing…";
}
