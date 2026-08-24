// Device-scoped, read-only forest data (v2 step 3, slice C). Mirrors the
// local useProjects / useWorktrees hooks, but keys the cache under the
// remote device id via hostKeysFor(deviceId) so a peer's projects and
// worktrees sit beside this machine's without colliding, and calls the
// per-device api (host methods routed over the socket) instead of
// window.api. No mutations live here: the remote forest is read only.
import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import type { Project, Worktree } from "@shared/schemas";
import type { RemoteDeviceApi } from "@/lib/remote/devices";
import { combineFanOut } from "@/hooks/worktrees/useWorktrees";
import { hostKeysFor } from "@/lib/queryKeys";

// A query is gated on a connected api: an unconnected device (api
// undefined, or an empty deviceId that never handshook) simply does not
// fetch, and the page renders its connecting or blocked state instead.
function remoteEnabled(
  deviceId: string,
  api: RemoteDeviceApi | undefined,
): boolean {
  return deviceId !== "" && api !== undefined;
}

export function remoteProjectsQueryOptions(
  deviceId: string,
  api: RemoteDeviceApi | undefined,
) {
  return queryOptions<Project[]>({
    queryKey: hostKeysFor(deviceId)("projects"),
    queryFn: () => (api ? api.projects.list() : []),
    enabled: remoteEnabled(deviceId, api),
    staleTime: 3_000,
    meta: { silentError: true },
  });
}

export function useRemoteProjects(
  deviceId: string,
  api: RemoteDeviceApi | undefined,
) {
  return useQuery(remoteProjectsQueryOptions(deviceId, api));
}

export function remoteWorktreesQueryOptions(
  deviceId: string,
  api: RemoteDeviceApi | undefined,
  projectId: string,
) {
  return queryOptions<Worktree[]>({
    queryKey: hostKeysFor(deviceId)("worktrees", projectId),
    queryFn: () => (api ? api.worktrees.list(projectId) : []),
    enabled: remoteEnabled(deviceId, api),
    staleTime: 3_000,
    meta: { silentError: true },
  });
}

// One query per project, positionally aligned with the projects passed
// in, sharing the per-project cache key with a future single-project
// hook. Uses the same combine projection as the local sidebar fan-out so
// referential identity survives a render when nothing changed.
export function useAllRemoteWorktrees(
  deviceId: string,
  api: RemoteDeviceApi | undefined,
  projects: Project[],
) {
  return useQueries({
    queries: projects.map((project) =>
      remoteWorktreesQueryOptions(deviceId, api, project.id),
    ),
    combine: combineFanOut,
  });
}
