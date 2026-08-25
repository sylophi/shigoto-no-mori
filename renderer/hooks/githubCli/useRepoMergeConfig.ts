import { useQuery } from "@tanstack/react-query";
import type { RepoMergeConfig } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

// Per-repo "which merge methods are allowed" settings. Cached
// aggressively (it almost never changes) and gated on gh readiness; a
// null result means we couldn't read it and the UI should fall back to
// allowing every method.
export function useRepoMergeConfig(projectId: string) {
  const { api, keys } = useHostScope();
  return useQuery<RepoMergeConfig | null>({
    queryKey: keys.repoMergeConfig(projectId),
    queryFn: () => api.githubCli.repoMergeConfig(projectId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    meta: { silentError: true },
  });
}
