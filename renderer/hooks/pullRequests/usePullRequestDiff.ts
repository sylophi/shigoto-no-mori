import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

// PR diffs are immutable from the user's POV once fetched (any new
// commit on the branch produces a different diff but we'd re-fetch on
// PR data invalidation anyway). Cached per (projectId, number) so
// reopening the page from the back arrow is instant.
export function usePullRequestDiff(
  projectId: string,
  number: number | undefined,
) {
  return useQuery<string>({
    queryKey: queryKeys.pullRequestDiff(projectId, number),
    queryFn: () => {
      if (number === undefined) return "";
      return window.api.githubCli.pullRequestDiff({ projectId, number });
    },
    enabled: number !== undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    meta: { errorTitle: "Couldn't load PR diff" },
  });
}
