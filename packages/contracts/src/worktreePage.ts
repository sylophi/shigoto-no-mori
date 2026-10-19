// A worktree's page in the app: the route the router serves it on
// (renderer/lib/routePaths.ts) and the one a deep link opens
// (`sm worktrees link`), whose printed link scripts read.
export const WORKTREE_PAGE_PATH =
  "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId" as const;

export const worktreePage = (ids: {
  readonly deviceId: string;
  readonly projectId: string;
  readonly worktreeId: string;
}): string =>
  WORKTREE_PAGE_PATH.replace("$deviceId", encodeURIComponent(ids.deviceId))
    .replace("$projectId", encodeURIComponent(ids.projectId))
    .replace("$worktreeId", encodeURIComponent(ids.worktreeId));
