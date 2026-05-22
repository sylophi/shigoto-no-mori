import { useQuery, type useQueryClient } from "@tanstack/react-query";
import type { PullRequest } from "@shared/schemas";

const WORKTREE_PR_KEY_PREFIX = ["githubCli", "worktreePullRequest"] as const;

export function worktreePullRequestKey(projectId: string, branch: string) {
  return [...WORKTREE_PR_KEY_PREFIX, projectId, branch] as const;
}

// Invalidates every active worktree PR query. The detail pane only
// mounts one at a time, but the IPC events that drive this are
// project-agnostic so we prefix-invalidate.
export function invalidateAllWorktreePullRequests(
  qc: ReturnType<typeof useQueryClient>,
) {
  void qc.invalidateQueries({ queryKey: WORKTREE_PR_KEY_PREFIX });
}

// Per-branch PR lookup for the open worktree page. Fetches on mount so
// opening a worktree feels instant; App.tsx invalidates it explicitly on
// window focus and on git refs changing, so we opt out of TanStack's
// stale-gated focus refetch path.
export function useWorktreePullRequest(projectId: string, branch: string) {
  return useQuery<PullRequest | null>({
    queryKey: worktreePullRequestKey(projectId, branch),
    queryFn: () =>
      window.api.githubCli.worktreePullRequest({ projectId, branch }),
    refetchOnWindowFocus: false,
    meta: { errorTitle: "Couldn't load pull request" },
  });
}
