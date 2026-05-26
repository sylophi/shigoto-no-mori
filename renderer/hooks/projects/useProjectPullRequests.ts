import { useQuery, type useQueryClient } from "@tanstack/react-query";
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

// Branch -> PR for a project, feeding the sidebar dots. The background
// sweep in main/fetch.ts refreshes it and broadcasts
// GithubCliProjectPullRequestsRefreshed only when the data actually
// changed; App.tsx invalidates this query off that broadcast. The open
// worktree page reads its PR through useWorktreePullRequest instead.
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
