import { queryOptions, skipToken, useQuery } from "@tanstack/react-query";
import type { HostScope } from "@/hooks/remote/useHostScope";
import { useDeviceApi } from "@/hooks/remote/useDeviceApi";
import { forestRead } from "@/hooks/remote/hostForestScope";
import { queryKeysFor } from "@/lib/queryKeys";

const DESCRIPTION_STALE_MS = 60 * 60_000;

// A project's GitHub About text, scoped to (device, project). An answer
// stands as long as the host keeps it (GithubCli's DESCRIPTION_TTL); a
// failed read (gh signed out, the network) is asked again.
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
        : ({ signal }) =>
            forestRead(deviceId, () =>
              api.run(api.githubCli.repoDescription({ projectId }), { signal }),
            ),
    staleTime: DESCRIPTION_STALE_MS,
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
