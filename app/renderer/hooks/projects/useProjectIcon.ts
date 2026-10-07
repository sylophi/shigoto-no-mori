import { queryOptions, skipToken, useQuery } from "@tanstack/react-query";
import type { ProjectIcon } from "@shared/schemas";
import type { HostScope } from "@/hooks/remote/useHostScope";
import { useDeviceApi } from "@/hooks/remote/useDeviceApi";
import { queryKeysFor } from "@/lib/queryKeys";

// The icon belongs to (device, project), not to a project alone, so the
// query takes the same scope pair projectsQueryOptions does: the key
// registry derives from the device id, and the queryFn calls that
// device's api. Disabled while the device has no api, so an offline
// peer still serves the icon its last session cached rather than
// dropping it. Cached forever: `null` is the success case for
// icon-less projects, not an error, and an icon does not change while
// the app runs.
function projectIconQueryOptions(
  projectId: string,
  scope: Pick<HostScope, "deviceId"> & { api: HostScope["api"] | undefined },
) {
  const { deviceId, api } = scope;
  return queryOptions<ProjectIcon | null>({
    queryKey: queryKeysFor(deviceId).projectIcon(projectId),
    queryFn: api === undefined ? skipToken : () => api.projects.icon(projectId),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    meta: { silentError: true },
  });
}

// A project's icon as a data URL, null for an icon-less project, or
// undefined while that isn't known yet: the first fetch is out, the
// device can't be asked (a peer not connected, with nothing cached),
// or the fetch failed. Unknown is not icon-less, so a repo with a logo
// never shows the generated tile on its way there. A deviceId names
// another machine than the surrounding scope's (useDeviceApi).
export function useProjectIcon(
  projectId: string,
  deviceId?: string,
): string | null | undefined {
  const { data } = useQuery(
    projectIconQueryOptions(projectId, useDeviceApi(deviceId)),
  );
  return data ? `data:${data.mime};base64,${data.base64}` : data;
}
