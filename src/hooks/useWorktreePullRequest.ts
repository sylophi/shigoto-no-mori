import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { pullRequestsEqual, type PullRequest } from "@shared/schemas";
import { projectPullRequestsKey } from "./useProjectPullRequests";

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
  const queryClient = useQueryClient();
  return useQuery<PullRequest | null>({
    queryKey: worktreePullRequestKey(projectId, branch),
    queryFn: async () => {
      const pr = await window.api.githubCli.worktreePullRequest({
        projectId,
        branch,
      });
      // Without this, the sidebar dot waits up to a full sweep tick to
      // catch a PR merging on GitHub even after the user opened the
      // worktree. Project-wide map already covers branches the user
      // hasn't visited via the timer sweep in main/fetch.ts.
      mirrorIntoProjectMap(queryClient, projectId, branch, pr);
      return pr;
    },
    refetchOnWindowFocus: false,
    meta: { errorTitle: "Couldn't load pull request" },
  });
}

function mirrorIntoProjectMap(
  queryClient: QueryClient,
  projectId: string,
  branch: string,
  pr: PullRequest | null,
): void {
  queryClient.setQueryData<Record<string, PullRequest>>(
    projectPullRequestsKey(projectId),
    (prev) => {
      if (!prev) return prev;
      const current = prev[branch];
      if (pr === null) {
        if (current === undefined) return prev;
        const next = { ...prev };
        delete next[branch];
        return next;
      }
      if (current && pullRequestsEqual(current, pr)) return prev;
      return { ...prev, [branch]: pr };
    },
  );
}
