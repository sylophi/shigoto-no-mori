// The worktree pages' route paths, spelled once. Each of the six
// exists twice -- under /projects on this machine, and under
// /devices/$deviceId as the twin serving a peer's worktree -- and the
// same strings are needed in two places that must agree byte for
// byte: the route tree (renderer/router.tsx) and the scope-aware
// navigation helpers (hooks/worktrees/useWorktreeNav.ts).
//
// The literal types are load-bearing: createRoute and navigate both
// infer a route's params from the path's literal type, so these must
// never widen to string. `twin` keeps each pair literal, the remote
// path spelled as the local one under /devices/$deviceId.
function twin<const P extends string>(local: P) {
  return {
    local,
    remote: `/devices/$deviceId${local}` as `/devices/$deviceId${P}`,
  };
}

export const WORKTREE_ROUTE_PATHS = {
  detail: twin("/projects/$projectId/worktrees/$worktreeId"),
  diff: twin("/projects/$projectId/worktrees/$worktreeId/diff"),
  prDiff: twin("/projects/$projectId/worktrees/$worktreeId/pr-diff"),
  commit: twin("/projects/$projectId/worktrees/$worktreeId/commits/$hash"),
  files: twin("/projects/$projectId/worktrees/$worktreeId/files"),
  script: twin("/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey"),
} as const;

// The project pages' route paths, the same twin shape: each exists
// under /projects for this machine's projects and under
// /devices/$deviceId for a peer's. A remote project's header offers the
// same actions a local one does (v2: remote feels local), and every one
// of them lands on one of these.
export const PROJECT_ROUTE_PATHS = {
  new: twin("/projects/$projectId/new"),
  configure: twin("/projects/$projectId/configure"),
  branches: twin("/projects/$projectId/branches"),
  convertExternal: twin("/projects/$projectId/convert-external"),
  worktreeLocation: twin("/projects/$projectId/worktree-location"),
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
