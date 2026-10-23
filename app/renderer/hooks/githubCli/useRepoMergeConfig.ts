import { queryOptions, useQuery } from "@tanstack/react-query";
import type { RepoMergeConfig } from "@shigomori/contracts/schemas";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import type { QueryKeyRegistry } from "@/lib/queryKeys";

// As long as the host keeps the settings (GithubCli's MERGE_CONFIG_TTL),
// and a null as long as it keeps gh's readiness (READINESS_TTL): a gh
// sign-in shows at the next focus after it, a remote added once the
// host's REPO_TTL has passed.
const SETTINGS_STALE_MS = 60 * 60_000;
const NOT_READY_STALE_MS = 30_000;

// Per-repo "which merge methods are allowed" settings, gated on gh
// readiness: null (gh not ready, or not a GitHub repo) and a failed read
// both leave the UI allowing every method. A failed read is asked again
// (the default retries, then the next mount).
function repoMergeConfigQueryOptions(
  api: HostApi,
  keys: QueryKeyRegistry,
  projectId: string,
) {
  return queryOptions<RepoMergeConfig | null>({
    queryKey: keys.repoMergeConfig(projectId),
    queryFn: ({ signal }) =>
      api.run(api.githubCli.repoMergeConfig({ projectId }), { signal }),
    staleTime: (query) =>
      query.state.data === null ? NOT_READY_STALE_MS : SETTINGS_STALE_MS,
    meta: { silentError: true },
  });
}

export function useRepoMergeConfig(projectId: string) {
  const { api, keys } = useHostScope();
  return useQuery(repoMergeConfigQueryOptions(api, keys, projectId));
}
