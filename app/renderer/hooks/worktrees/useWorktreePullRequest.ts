import { useRef } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  matchesMapEntry,
  toSlimPullRequest,
  type PullRequest,
  type PullRequestDetail,
} from "@shared/schemas";
import {
  isWorktreePullRequestKey,
  type QueryKeyRegistry,
} from "@/lib/queryKeys";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { pullRequestMutationKey } from "@/hooks/projects/useProjectPullRequests";
import { mergeStateSettling } from "@/lib/pullRequest";

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
  void qc.invalidateQueries({
    queryKey: keys.pullRequestsForProject(projectId),
    predicate: isWorktreePullRequestKey,
  });
}

// Per-branch PR lookup for the open worktree page, on whichever device
// the scope names. Fetches on mount so opening a worktree feels
// instant, refetches when the window regains focus (a PR updated on
// github.com while the app was backgrounded) and when the device's refs
// move (invalidateWorktreePullRequests). A PR changing on GitHub with
// none of those happening reaches it through the sweep broadcast
// (syncProjectPullRequests). Silent on error to match the sweep's
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
  return useQuery<PullRequestDetail | null>({
    queryKey: keys.worktreePullRequest(projectId, branch),
    queryFn: async () => {
      const pr = await api.githubCli.worktreePullRequest({
        projectId,
        branch,
      });
      // Without this, the sidebar dot waits up to a full sweep tick to
      // catch a PR merging on GitHub even after the user opened the
      // worktree. The IPC throws on transient gh failure, so we only
      // reach here with ground truth and never clobber the project map
      // on a network hiccup. The sweep in main/electron/fetch.ts still covers
      // branches the user hasn't visited.
      mirrorIntoProjectMap(queryClient, keys, projectId, branch, pr);
      return pr;
    },
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
      settlingSince.current ??= Date.now();
      return Date.now() - settlingSince.current < SETTLE_WINDOW_MS
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
}

function mirrorIntoProjectMap(
  queryClient: QueryClient,
  keys: QueryKeyRegistry,
  projectId: string,
  branch: string,
  pr: PullRequestDetail | null,
): void {
  // Read-then-maybe-write so we skip setQueryData entirely when nothing
  // changed; even an updater that returns `prev` still bumps
  // dataUpdatedAt and notifies every sidebar row observing the project
  // map.
  const key = keys.projectPullRequests(projectId);
  const prev = queryClient.getQueryData<Record<string, PullRequest>>(key);
  if (!prev || matchesMapEntry(pr, prev[branch])) return;
  if (pr === null) {
    const next = { ...prev };
    delete next[branch];
    queryClient.setQueryData<Record<string, PullRequest>>(key, next);
    return;
  }
  queryClient.setQueryData<Record<string, PullRequest>>(key, {
    ...prev,
    [branch]: toSlimPullRequest(pr),
  });
}
