import { useEffect, useRef } from "react";
import { refreshQueries } from "@/lib/askAgain";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  matchesMapEntry,
  type PullRequestDetail,
} from "@shigomori/contracts/schemas";
import {
  isWorktreePullRequestKey,
  type QueryKeyRegistry,
} from "@/lib/queryKeys";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  pullRequestMutationKey,
  useProjectPullRequests,
} from "@/hooks/projects/useProjectPullRequests";
import {
  mergeStateSettling,
  ownBranchPullRequest,
} from "@shigomori/ui/lib/pullRequest.ts";

// How often, and for how long, to re-ask while GitHub is still
// computing the merge state. Some PRs sit at UNKNOWN until something
// else nudges GitHub, so the poll gives up rather than run forever.
const SETTLE_POLL_MS = 3_000;
const SETTLE_WINDOW_MS = 30_000;

// One project's per-branch PR queries on a device, for its
// refsRefreshed broadcast (lib/hostWatch.ts): refs landing (a merge or
// a push) are what most often move a PR. The predicate skips the
// project map, which has its own sweep-driven refresh.
export function invalidateWorktreePullRequests(
  qc: QueryClient,
  keys: QueryKeyRegistry,
  projectId: string,
) {
  refreshQueries(qc, {
    queryKey: keys.pullRequestsForProject(projectId),
    predicate: isWorktreePullRequestKey,
  });
}

// Per-branch PR lookup for the open worktree page, on whichever device
// the scope names. Fetches on mount so opening a worktree feels
// instant, refetches when the window regains focus (a PR updated on
// github.com while the app was backgrounded), when the device's refs
// move (invalidateWorktreePullRequests), and when the project's map (the
// host's view of its sweep) disagrees with it, so a PR flipped on
// github.com reaches an open page within a sweep. The host writes what
// this read learns into that map. Silent on error to match the sweep's
// swallow behavior. A transient gh failure shouldn't toast.
export function useWorktreePullRequest(
  projectId: string,
  branch: string,
  options: { enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  // When the current settling run began, so the poll below is bounded.
  const settlingSince = useRef<number | null>(null);
  const page = useQuery<PullRequestDetail | null>({
    queryKey: keys.worktreePullRequest(projectId, branch),
    queryFn: async ({ signal }) =>
      ownBranchPullRequest(
        await api.run(
          api.githubCli.worktreePullRequest({ projectId, branch }),
          { signal },
        ),
      ),
    enabled: options.enabled ?? true,
    // Nothing else refetches once the merge state is the only thing
    // lagging (the sweep's map doesn't carry it), so poll briefly. Not
    // while a merge or draft toggle runs: its optimistic write reads as
    // settling too, and a poll landing mid-mutation would put the old
    // state back. Its own settle refetch starts the poll if needed.
    refetchInterval: (query) => {
      const pr = query.state.data;
      if (!pr || !mergeStateSettling(pr)) {
        settlingSince.current = null;
        return false;
      }
      if (queryClient.isMutating({ mutationKey: pullRequestMutationKey(keys) }))
        return false;
      if (settlingSince.current === null) {
        settlingSince.current = performance.now();
      }
      return performance.now() - settlingSince.current < SETTLE_WINDOW_MS
        ? SETTLE_POLL_MS
        : false;
    },
    // gh failures here are stable (not in a github repo, gh not authed,
    // network down), so the default 3-retry exponential backoff just
    // turns a fast error into a 7s wait. The focus refetch and the
    // refs-changed invalidation bring us back from a true transient.
    retry: false,
    meta: { silentError: true },
  });
  // The map holds only the newest 200 PRs (host PR_LIST_LIMIT), so one
  // missing from it says nothing about this page's PR. A pending merge
  // or draft toggle has written its optimistic result here, which the
  // map can't match yet: the mutation refreshes the page as it settles.
  // Only the map moving asks again: the page's own answer lands in it.
  const entry = useProjectPullRequests(projectId).data?.[branch];
  useEffect(() => {
    const shown = queryClient.getQueryData<PullRequestDetail | null>(
      keys.worktreePullRequest(projectId, branch),
    );
    if (shown === undefined || (shown !== null && entry === undefined)) return;
    if (queryClient.isMutating({ mutationKey: pullRequestMutationKey(keys) }))
      return;
    if (!matchesMapEntry(shown, entry)) {
      refreshQueries(queryClient, {
        queryKey: keys.worktreePullRequest(projectId, branch),
        exact: true,
      });
    }
  }, [entry, queryClient, keys, projectId, branch]);
  return page;
}
