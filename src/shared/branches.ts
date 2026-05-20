// Branch-name sanitization shared between main (used when creating the
// worktree directory) and renderer (used to preview the destination path
// in the new-worktree form).

const PATH_SEPARATOR = /[\\/]/g;
const INVALID_CHARS = /[^A-Za-z0-9._-]/g;

export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(PATH_SEPARATOR, "-").replace(INVALID_CHARS, "_");
}

// Live sanitizer for branch-name text inputs. Forward slashes stay valid
// (git uses them for namespaces like feat/foo); anything else outside the
// safe set becomes a dash so a stray space or punctuation can't smuggle in
// a ref git will refuse.
const INVALID_BRANCH_INPUT_CHARS = /[^A-Za-z0-9._/-]/g;

export function sanitizeBranchName(name: string): string {
  return name.replace(INVALID_BRANCH_INPUT_CHARS, "-");
}
