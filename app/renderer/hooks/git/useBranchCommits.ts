import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  BranchHistory,
  CommitSummary,
} from "@shigomori/contracts/schemas";
import type { QueryKeyRegistry } from "@/lib/queryKeys";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useTreeView } from "@/hooks/worktrees/useWorktreeChanges";

const BRANCH_COMMITS_PAGE_SIZE = 30;

// What the Git timeline draws: the branch's own commits back to where
// it left the primary branch, and its upstream. The host's view, read
// again as the project's git moves.
export function useBranchHistory(projectId: string, worktreeId?: string) {
  return useTreeView<BranchHistory>(
    "watchBranchHistory",
    worktreeId === undefined ? null : { projectId, worktreeId },
    "Couldn't read the branch's commits",
  );
}

// Pages through `git log` in PAGE_SIZE chunks, from `from` (a commit,
// for the history before the branch) or HEAD, or through a search of
// the messages. The cursor is the number already loaded, fed back as
// `skip`, and a short page ends it. HEAD's hash is in the key, so any
// HEAD movement drops the stale pages.
export function useBranchCommits(
  projectId: string,
  worktreeId: string,
  headHash: string | undefined,
  opts: { query?: string; from?: string } = {},
) {
  const { api, keys } = useHostScope();
  return useInfiniteQuery<
    readonly CommitSummary[],
    Error,
    { pages: (readonly CommitSummary[])[]; pageParams: number[] },
    ReturnType<QueryKeyRegistry["branchCommits"]>,
    number
  >({
    queryKey: keys.branchCommits(projectId, worktreeId, headHash, opts),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.run(
        api.worktrees.listCommits({
          projectId,
          worktreeId,
          skip: pageParam,
          count: BRANCH_COMMITS_PAGE_SIZE,
          query: opts.query,
          from: opts.from,
        }),
        { signal },
      ),
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < BRANCH_COMMITS_PAGE_SIZE) return undefined;
      return allPages.reduce((sum, page) => sum + page.length, 0);
    },
    meta: { errorTitle: "Couldn't load the history" },
  });
}

// One commit's row, read by its hash: the first of `git log` from it.
// For a commit none of the page's lists holds (a search's, one HEAD
// moved away from, a deep link's).
export function useCommitSummary(
  projectId: string,
  worktreeId: string | undefined,
  hash: string,
  enabled: boolean,
) {
  const { api, keys } = useHostScope();
  return useQuery({
    queryKey: keys.commitSummary(projectId, worktreeId, hash),
    queryFn: async ({ signal }) => {
      const [commit] = await api.run(
        api.worktrees.listCommits({
          projectId,
          worktreeId: worktreeId ?? "",
          skip: 0,
          count: 1,
          from: hash,
        }),
        { signal },
      );
      return commit ?? null;
    },
    enabled: enabled && worktreeId !== undefined,
    staleTime: Infinity,
    meta: { errorTitle: "Couldn't read the commit" },
  });
}
