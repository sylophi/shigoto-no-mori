import { useQuery } from "@tanstack/react-query";
import type { PullRequest } from "@shared/schemas";

// Branch -> PR for a project. Runs on its own refresh cycle so the
// (slower) gh subprocess never blocks the git-driven worktree list.
// staleTime matches the main-side gh-pr-list TTL so window focus inside
// that window doesn't cross the IPC boundary just to hit the cache.
export function useProjectPullRequests(projectId: string) {
  return useQuery<Record<string, PullRequest>>({
    queryKey: ["githubCli", "projectPullRequests", projectId],
    queryFn: () => window.api.githubCli.projectPullRequests({ projectId }),
    staleTime: 30_000,
    meta: { errorTitle: "Couldn't load pull requests" },
  });
}
