import { useInfiniteQuery } from "@tanstack/react-query";
import type { CommitSummary } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export const BRANCH_COMMITS_PAGE_SIZE = 50;

// Pages the worktree's `git log HEAD` in PAGE_SIZE chunks. The cursor is
// the cumulative number of commits already loaded, which we feed back as
// `skip`. A short final page (fewer than PAGE_SIZE rows) ends the
// scroll. Disabled until the drawer opens so closed detail pages don't
// run the query at all.
//
// The worktree id is path-derived, so it doesn't change when the user
// switches branches, renames, or pulls inside the same worktree. We
// also fold the current HEAD hash into the key so any HEAD movement
// (branch switch, pull, rebase, overwrite) drops the stale pages
// instead of reusing them under a new branch's title.
export function useBranchCommits(
  projectId: string,
  worktreeId: string,
  headHash: string | undefined,
  enabled: boolean,
) {
  return useInfiniteQuery<
    CommitSummary[],
    Error,
    { pages: CommitSummary[][]; pageParams: number[] },
    readonly ["branchCommits", string, string, string | undefined],
    number
  >({
    queryKey: queryKeys.branchCommits(projectId, worktreeId, headHash),
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      window.api.worktrees.listCommits({
        projectId,
        worktreeId,
        skip: pageParam,
        count: BRANCH_COMMITS_PAGE_SIZE,
      }),
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < BRANCH_COMMITS_PAGE_SIZE) return undefined;
      return allPages.reduce((sum, page) => sum + page.length, 0);
    },
    meta: { errorTitle: "Couldn't load branch history" },
  });
}
