import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PullRequest } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export function invalidateProjectPullRequests(
  qc: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  void qc.invalidateQueries({
    queryKey: queryKeys.projectPullRequests(projectId),
  });
}

// Refetch the per-project PR map when main broadcasts that its sweep
// detected a change. The broadcast is only emitted on actual diff, so
// every event corresponds to a real update.
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
