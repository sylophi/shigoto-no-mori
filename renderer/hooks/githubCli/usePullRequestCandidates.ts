import { useQuery } from "@tanstack/react-query";
import type { PullRequestCandidateList } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Open PRs offered as a source in the new-worktree form. Lazy on
// purpose: `enabled` stays false until the user picks the PR mode, so
// the form's usual open-and-create path never pays for a gh call. Once
// it has run, the cached answer (including an "unavailable" verdict)
// survives the form unmounting, so returning to it knows straight away
// whether the mode is worth offering.
export function usePullRequestCandidates(projectId: string, enabled: boolean) {
  return useQuery<PullRequestCandidateList>({
    queryKey: queryKeys.pullRequestCandidates(projectId),
    queryFn: () => window.api.githubCli.pullRequestCandidates(projectId),
    enabled,
    staleTime: 60_000,
    meta: { errorTitle: "Couldn't load pull requests" },
  });
}
