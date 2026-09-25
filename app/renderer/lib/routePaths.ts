// The device pages' route paths, spelled once. Every worktree and
// project page lives under /devices/$deviceId, this machine's included
// (the route's scope resolves its id to window.api, see
// components/remote/RemoteScope.tsx), and the same strings are needed
// in places that must agree byte for byte: the route tree
// (renderer/router.tsx), the scope-aware navigation helpers
// (hooks/worktrees/useWorktreeNav.ts, hooks/projects/useProjectNav.ts)
// and the sidebar's selected-row rule.
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
  commit:
    "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/commits/$hash",
  files: "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/files",
  script:
    "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey",
} as const;

export const PROJECT_ROUTE_PATHS = {
  new: "/devices/$deviceId/projects/$projectId/new",
  configure: "/devices/$deviceId/projects/$projectId/configure",
  branches: "/devices/$deviceId/projects/$projectId/branches",
  convertExternal: "/devices/$deviceId/projects/$projectId/convert-external",
  worktreeLocation: "/devices/$deviceId/projects/$projectId/worktree-location",
} as const;

// The sidebar and the palette name this machine's rows with no device
// (worktreeRowKey), the routes name every device by id. These two cross
// between the two spellings.
export function routeDeviceId(rowDevice: string | undefined): string {
  return rowDevice ?? localDeviceId;
}

export function rowDeviceId(routeDevice: string): string | undefined {
  return routeDevice === localDeviceId ? undefined : routeDevice;
}

type RouteParams = Record<string, string>;

// Fills a route template's `$param` segments with values, for the
// places that compare against location.pathname rather than navigate
// (the sidebar's selected-row rule). The pathname is already decoded,
// so the values go in as they are.
export function fillRoutePath(template: string, params: RouteParams): string {
  return template.replace(/\$([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`route param ${name} missing`);
    return value;
  });
}

// Matches a pathname against a route template, the `$param` segments
// coming back keyed by name, so a caller never depends on their order.
export function matchRoutePath(
  template: string,
  pathname: string,
): Record<string, string> | null {
  const pattern = new RegExp(
    `^${template.replace(/\$([A-Za-z]+)/g, "(?<$1>[^/]+)")}$`,
  );
  const groups = pathname.match(pattern)?.groups;
  return groups ? { ...groups } : null;
}
