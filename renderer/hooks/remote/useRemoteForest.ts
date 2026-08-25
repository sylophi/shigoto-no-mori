// Device-scoped, read-only forest data (v2 step 3, slice C). Mirrors the
// local useProjects / useWorktrees hooks, but scopes the shared options
// builders to the peer: they derive the key registry from the passed
// device id (queryKeysFor), so a peer's projects and worktrees sit
// beside this machine's without colliding, and the queryFns call the
// per-device api (host methods routed over the socket) instead of
// window.api. No mutations live here: the remote forest is read only.
import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import type { Project } from "@shared/schemas";
import type { RemoteDeviceApi } from "@/lib/remote/devices";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import {
  combineFanOut,
  worktreesQueryOptions,
} from "@/hooks/worktrees/useWorktrees";

// The remote builders scope the shared local options to a peer's device
// id and api. The options builders own the key shape, the queryFn and the
// connected gating (an unconnected device, no api or an empty id, never
// fetches), so this file no longer forks that logic. Projects override
// the base meta to stay silent, since the remote forest renders its own
// inline error rather than a global toast.
export function remoteProjectsQueryOptions(
  deviceId: string,
  api: RemoteDeviceApi | undefined,
) {
  return queryOptions<Project[]>({
    ...projectsQueryOptions({ deviceId, api }),
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
  return worktreesQueryOptions(projectId, { deviceId, api });
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
