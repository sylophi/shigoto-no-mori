// The device pages' route paths, spelled once. Every worktree and
// project page lives under /devices/$deviceId, this machine's included
// (the route's scope resolves its id to window.api, see
// components/remote/RemoteScope.tsx), and the same strings are needed
// in places that must agree byte for byte: the route tree
// (renderer/router.tsx), the scope-aware navigation helpers
// (hooks/worktrees/useWorktreeNav.ts, hooks/projects/useProjectNav.ts)
// and the sidebar's matches (useMatch).
//
// The literal types are load-bearing: createRoute and navigate both
// infer a route's params from the path's literal type, so these must
// never widen to string.
import { localDeviceId } from "@/lib/queryKeys";

export const WORKTREE_ROUTE_PATHS = {
  detail: "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId",
  diff: "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/diff",
  prDiff:
    "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/pr-diff",
  branchDiff:
    "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/branch-diff",
  stashes:
    "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/stashes",
  stash:
    "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/stashes/$hash",
  commit:
    "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/commits/$hash",
  files: "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/files",
} as const;

export const PROJECT_ROUTE_PATHS = {
  new: "/devices/$deviceId/projects/$projectId/new",
  configure: "/devices/$deviceId/projects/$projectId/configure",
  branches: "/devices/$deviceId/projects/$projectId/branches",
  convertExternal: "/devices/$deviceId/projects/$projectId/convert-external",
  worktreeLocation:
    "/devices/$deviceId/projects/$projectId/configure/worktree-location",
} as const;

// A device's own terminals (components/terminal/DeviceTerminals.tsx).
export const DEVICE_TERMINALS_PATH = "/devices/$deviceId/terminals";

// The sidebar and the palette name this machine's rows with no device
// (worktreeRowKey), the routes name every device by id. These two cross
// between the two spellings.
export function routeDeviceId(rowDevice: string | undefined): string {
  return rowDevice ?? localDeviceId;
}

export function rowDeviceId(routeDevice: string): string | undefined {
  return routeDevice === localDeviceId ? undefined : routeDevice;
}
