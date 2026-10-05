import { queryOptions, skipToken, useQuery } from "@tanstack/react-query";
import type { ProjectIcon } from "@shared/schemas";
import { useHostScope, type HostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceApi } from "@/hooks/remote/useRemoteDevices";
import { localDeviceId, queryKeysFor } from "@/lib/queryKeys";

// The icon belongs to (device, project), not to a project alone, so the
// query takes the same scope pair projectsQueryOptions does: the key
// registry derives from the device id, and the queryFn calls that
// device's api. Disabled while the device has no api, so an offline
// peer still serves the icon its last session cached rather than
// dropping it. Cached forever: `null` is the success case for
// icon-less projects, not an error, and an icon does not change while
// the app runs.
export function projectIconQueryOptions(
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
// never shows the generated tile on its way there.
// With no deviceId it rides the surrounding host scope (a device-scoped
// page, or the local default). With one it names another machine, and
// the api comes from the remote device store through a selector, so
// the surfaces that mention a project from another device outside its
// scope (the merged sidebar's remote headers, the device chips on
// /account) neither mount a HostScopeProvider for a single read nor
// re-render on every roster transition.
export function useProjectIcon(
  projectId: string,
  deviceId?: string,
): string | null | undefined {
  const scope = useHostScope();
  const targetId = deviceId ?? scope.deviceId;
  // The store never lists this machine, so naming it explicitly from
  // inside a peer's scope must resolve to window.api, not to nothing.
  const known = targetId === scope.deviceId || targetId === localDeviceId;
  const peerApi = useRemoteDeviceApi(known ? undefined : targetId);
  const api =
    targetId === scope.deviceId
      ? scope.api
      : targetId === localDeviceId
        ? window.api
        : peerApi;
  const { data } = useQuery(
    projectIconQueryOptions(projectId, { deviceId: targetId, api }),
  );
  return data ? `data:${data.mime};base64,${data.base64}` : data;
}
