// Branch-name sanitization shared between main (used when creating the
// worktree directory) and renderer (used to preview the destination path
// in the new-worktree form).

export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[\\/]/g, "-").replace(/[^A-Za-z0-9._-]/g, "_");
}
