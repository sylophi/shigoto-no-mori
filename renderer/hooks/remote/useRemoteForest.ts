// Device-scoped, read-only forest data (v2 step 3, slice C). Mirrors the
// local useProjects / useWorktrees hooks, but scopes the shared options
// builders to the peer: they derive the key registry from the passed
// device id (queryKeysFor), so a peer's projects and worktrees sit
// beside this machine's without colliding, and the queryFns call the
// per-device api (host methods routed over the socket) instead of
// window.api. Options builders only: useRemoteForests fans these out
// across every device for the sidebar's merged tree, which is the one
// place a peer's forest is read.
import { queryOptions } from "@tanstack/react-query";
import type { Project } from "@shared/schemas";
import type { RemoteDeviceApi } from "@/lib/remote/devices";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";

// The remote builders scope the shared local options to a peer's device
// id and api. The options builders own the key shape, the queryFn and the
// connected gating (an unconnected device, no api or an empty id, never
// fetches), so this file no longer forks that logic. Projects override
// the base meta to stay silent, since the sidebar folds a failed listing
// into its own coalesced toast rather than a global one per device.
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

export function remoteWorktreesQueryOptions(
  deviceId: string,
  api: RemoteDeviceApi | undefined,
  projectId: string,
) {
  return worktreesQueryOptions(projectId, { deviceId, api });
}
