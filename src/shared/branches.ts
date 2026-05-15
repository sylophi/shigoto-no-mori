// Branch-name sanitization shared between main (used when creating the
// worktree directory) and renderer (used to preview the destination path
// in the new-worktree form).

const PATH_SEPARATOR = /[\\/]/g;
const INVALID_CHARS = /[^A-Za-z0-9._-]/g;

export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(PATH_SEPARATOR, "-").replace(INVALID_CHARS, "_");
}
