import { useInfiniteQuery } from "@tanstack/react-query";
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
