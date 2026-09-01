// The worktree pages' route paths, spelled once. Each of the four
// exists twice -- under /projects on this machine, and under
// /devices/$deviceId as the twin serving a peer's worktree -- and the
// same strings are needed in three places that must agree byte for
// byte: the desktop route tree (renderer/router.tsx), the web one
// (web/app/router.tsx, which reads renderer modules through the same
// "@" alias) and the scope-aware navigation helpers
// (hooks/worktrees/useWorktreeNav.ts).
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
} as const;
