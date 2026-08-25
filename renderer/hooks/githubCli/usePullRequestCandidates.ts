import { useQuery } from "@tanstack/react-query";
import type { PullRequestCandidateList } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

// Open PRs offered as a source in the new-worktree form. The form opens
// on the PR mode, so this runs on mount and pays a gh call per open. The
// global `refetchOnMount: "always"` sees to that, and a picker of what's
// open on GitHub right now is worth refetching. `enabled` goes false
// once the user picks one of the branch modes instead. The cached answer
// (including an "unavailable" verdict) is what the form reads while that
// refetch is in flight, so reopening it never flashes the wrong mode.
export function usePullRequestCandidates(projectId: string, enabled: boolean) {
  const { api, keys } = useHostScope();
  return useQuery<PullRequestCandidateList>({
    queryKey: keys.pullRequestCandidates(projectId),
    queryFn: () => api.githubCli.pullRequestCandidates(projectId),
    enabled,
    staleTime: 60_000,
    meta: { errorTitle: "Couldn't load pull requests" },
  });
}
