import { useEffect } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  pullRequestsEqual,
  toSlimPullRequest,
  type PullRequest,
  type PullRequestDetail,
} from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Invalidates per-branch PR queries across projects (one tab worth,
// since only one detail pane mounts at a time). The predicate skips
// project-map queries, which have their own sweep-driven refresh and
// shouldn't refetch on every window focus.
export function invalidateAllWorktreePullRequests(
  qc: ReturnType<typeof useQueryClient>,
) {
  void qc.invalidateQueries({
    queryKey: queryKeys.pullRequestsAll(),
    predicate: (q) => q.queryKey[3] === "branch",
  });
}

// Refresh the open worktree's PR on the two events most likely to move
// PR state: refs landing locally (merge or push) and the window regaining
// focus (PR updated on github.com while the app was backgrounded). The
// per-branch query opts out of React Query's focus refetch so this
// listener owns the focus path.
export function useWatchWorktreePullRequests(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const offRefs = window.api.git.onRefsRefreshed(() => {
      invalidateAllWorktreePullRequests(queryClient);
    });
    const offFocus = window.api.window.onFocused(() => {
      invalidateAllWorktreePullRequests(queryClient);
    });
    return () => {
      offRefs();
      offFocus();
    };
  }, [queryClient]);
}

// Per-branch PR lookup for the open worktree page. Fetches on mount so
// opening a worktree feels instant; useWatchWorktreePullRequests invalidates
// it explicitly on window focus and on git refs changing, so we opt out
// of TanStack's stale-gated focus refetch path. Silent on error to match
// the sweep's swallow behavior -- a transient gh failure shouldn't toast.
export function useWorktreePullRequest(
  projectId: string,
  branch: string,
  options: { enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  return useQuery<PullRequestDetail | null>({
    queryKey: queryKeys.worktreePullRequest(projectId, branch),
    queryFn: async () => {
      const pr = await window.api.githubCli.worktreePullRequest({
        projectId,
        branch,
      });
      // Without this, the sidebar dot waits up to a full sweep tick to
      // catch a PR merging on GitHub even after the user opened the
      // worktree. The IPC throws on transient gh failure, so we only
      // reach here with ground truth -- never clobber the project map
      // on a network hiccup. The sweep in main/fetch.ts still covers
      // branches the user hasn't visited.
      mirrorIntoProjectMap(queryClient, projectId, branch, pr);
      return pr;
    },
    enabled: options.enabled ?? true,
    refetchOnWindowFocus: false,
    // gh failures here are stable (not in a github repo, gh not authed,
    // network down) -- the default 3-retry exponential backoff just
    // turns a fast error into a 7s wait. The focus + refs-changed
    // invalidations bring us back from a true transient.
    retry: false,
    meta: { silentError: true },
  });
}

function mirrorIntoProjectMap(
  queryClient: QueryClient,
  projectId: string,
  branch: string,
  pr: PullRequestDetail | null,
): void {
  // Read-then-maybe-write so we skip setQueryData entirely when nothing
  // changed; even an updater that returns `prev` still bumps
  // dataUpdatedAt and notifies every sidebar row observing the project
  // map.
  const key = queryKeys.projectPullRequests(projectId);
  const prev = queryClient.getQueryData<Record<string, PullRequest>>(key);
  if (!prev) return;
  const current = prev[branch];
  if (pr === null) {
    if (current === undefined) return;
    const next = { ...prev };
    delete next[branch];
    queryClient.setQueryData<Record<string, PullRequest>>(key, next);
    return;
  }
  const slim = toSlimPullRequest(pr);
  if (current && pullRequestsEqual(current, slim)) return;
  queryClient.setQueryData<Record<string, PullRequest>>(key, {
    ...prev,
    [branch]: slim,
  });
}
