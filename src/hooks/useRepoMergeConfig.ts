import { useQuery } from "@tanstack/react-query";
import type { RepoMergeConfig } from "@shared/schemas";

// Per-repo "which merge methods are allowed" settings. Cached
// aggressively (it almost never changes) and gated on gh readiness; a
// null result means we couldn't read it and the UI should fall back to
// allowing every method.
export function useRepoMergeConfig(projectId: string) {
  return useQuery<RepoMergeConfig | null>({
    queryKey: ["githubCli", "repoMergeConfig", projectId],
    queryFn: () => window.api.githubCli.repoMergeConfig({ projectId }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    meta: { silentError: true },
  });
}
