import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PullRequest } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Cascading invalidator: the shared key prefix knocks out both the
// sidebar map and any open per-branch detail in one call, so PR
// mutations can't desync the two layers by forgetting one.
export function invalidatePullRequestsForProject(
  qc: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  void qc.invalidateQueries({
    queryKey: queryKeys.pullRequestsForProject(projectId),
  });
}

// Narrow invalidator for the sweep broadcast: the sweep already
// refreshed the project map in main, so the renderer just needs to
// pick that up. Cascading to per-branch would fire an extra `gh pr
// list --head` every minute when the detail page is open, even though
// the focus + refs-changed paths already keep that query fresh.
function invalidateProjectPullRequests(
  qc: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  void qc.invalidateQueries({
    queryKey: queryKeys.projectPullRequests(projectId),
  });
}

export function useWatchProjectPullRequests(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.api.githubCli.onProjectPullRequestsRefreshed(({ projectId }) => {
        invalidateProjectPullRequests(queryClient, projectId);
      }),
    [queryClient],
  );
}

// Branch -> PR for a project, feeding the sidebar dots. The background
// sweep in main/fetch.ts refreshes it and broadcasts
// GithubCliProjectPullRequestsRefreshed only when the data actually
// changed; useWatchProjectPullRequests invalidates this query off that
// broadcast. The open worktree page reads its PR through
// useWorktreePullRequest instead.
export function useProjectPullRequests(projectId: string) {
  return useQuery<Record<string, PullRequest>>({
    queryKey: queryKeys.projectPullRequests(projectId),
    queryFn: () => window.api.githubCli.projectPullRequests({ projectId }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    meta: { errorTitle: "Couldn't load pull requests" },
  });
}
