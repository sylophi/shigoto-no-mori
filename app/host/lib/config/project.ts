// A project's settings and a worktree's own data, in the store. The
// project-wide settings (scripts, layout, ...) are read and written
// through the engine's Config (host/lib/engineOps.ts), as `sm projects
// config` does. A worktree's data is the custom ports the app adds and
// the title and description `sm describe` sets, each kept beside the
// other.

// A worktree's key, for the caches keyed by one.
export function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}:${worktreeId}`;
}

export function parseWorktreeKey(key: string): {
  projectId: string;
  worktreeId: string;
} {
  const [projectId, worktreeId, ...extra] = key.split(":");
  if (projectId === undefined || worktreeId === undefined || extra.length > 0) {
    throw new Error(`worktree key ${key} is not projectId:worktreeId`);
  }
  return { projectId, worktreeId };
}
