import { queryOptions, skipToken, useQuery } from "@tanstack/react-query";
import type { HostScope } from "@/hooks/remote/useHostScope";
import { useDeviceApi } from "@/hooks/remote/useDeviceApi";
import { queryKeysFor } from "@/lib/queryKeys";

// A project's GitHub About text, scoped to (device, project) and kept
// as the icon is (projectIconQueryOptions): once per launch, as the
// host reads it.
function repoDescriptionQueryOptions(
  projectId: string,
  scope: Pick<HostScope, "deviceId"> & { api: HostScope["api"] | undefined },
) {
  const { deviceId, api } = scope;
  return queryOptions<string | null>({
    queryKey: queryKeysFor(deviceId).repoDescription(projectId),
    queryFn:
      api === undefined
        ? skipToken
        : () => api.githubCli.repoDescription(projectId),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    meta: { silentError: true },
  });
}

// The About text, null when the repo has none (or isn't on GitHub),
// undefined until that's known. Not asked while `enabled` is false: a
// project missing on disk would read as having none, and keep that
// for the launch after it comes back.
export function useRepoDescription(
  projectId: string,
  deviceId: string | undefined,
  enabled: boolean,
): string | null | undefined {
  const { data } = useQuery({
    ...repoDescriptionQueryOptions(projectId, useDeviceApi(deviceId)),
    enabled,
  });
  return data;
}
