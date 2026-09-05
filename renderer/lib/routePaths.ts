// The worktree pages' route paths, spelled once. Each of the five
// exists twice -- under /projects on this machine, and under
// /devices/$deviceId as the twin serving a peer's worktree -- and the
// same strings are needed in two places that must agree byte for
// byte: the route tree (renderer/router.tsx) and the scope-aware
// navigation helpers (hooks/worktrees/useWorktreeNav.ts).
//
// `as const` is load-bearing: createRoute and navigate both infer a
// route's params from the path's literal type, so these must never
// widen to string.
export const WORKTREE_ROUTE_PATHS = {
  detail: {
    local: "/projects/$projectId/worktrees/$worktreeId",
    remote: "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId",
  },
  diff: {
    local: "/projects/$projectId/worktrees/$worktreeId/diff",
    remote: "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/diff",
  },
  prDiff: {
    local: "/projects/$projectId/worktrees/$worktreeId/pr-diff",
    remote:
      "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/pr-diff",
  },
  commit: {
    local: "/projects/$projectId/worktrees/$worktreeId/commits/$hash",
    remote:
      "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/commits/$hash",
  },
  script: {
    local: "/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey",
    remote:
      "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey",
  },
} as const;

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
