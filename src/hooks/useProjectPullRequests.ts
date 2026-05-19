import { useQuery } from "@tanstack/react-query";
import type { PullRequest } from "@shared/schemas";

// Branch -> PR for a project. Runs on its own refresh cycle so the
// (slower) gh subprocess never blocks the git-driven worktree list.
// Returns {} on integration-off or gh-not-ready -- consumers just see
// no PR for any branch.
export function useProjectPullRequests(projectId: string) {
  return useQuery<Record<string, PullRequest>>({
    queryKey: ["githubCli", "projectPullRequests", projectId],
    queryFn: () => window.api.githubCli.projectPullRequests({ projectId }),
    meta: { errorTitle: "Couldn't load pull requests" },
  });
}
