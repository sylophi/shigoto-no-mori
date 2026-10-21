// Unicode passes through; only what breaks a single path segment goes
// (separators, `:` which Finder treats as one, control characters).
// `root`/`primary` are the CLI's address keywords. An empty result means
// fall back to a picked name.

const PATH_SEPARATOR = /[/:]/g;
// oxlint-disable-next-line no-control-regex -- intentional: strips control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
// The CLI matches its keywords case-insensitively.
const RESERVED_NAMES = new Set([".", "..", "root", "primary"]);

export function sanitizeBranchForPath(branch: string): string {
  const slashed = branch
    .replace(PATH_SEPARATOR, "-")
    .replace(CONTROL_CHARS, "");
  // The space, not JS's `\s`, which would trim Unicode spaces too (the
  // control characters are gone already): a branch keeps the folder
  // name its existing worktrees have.
  const trimmed = slashed.replace(/^[.\t\n\f\r -]+|[.\t\n\f\r -]+$/g, "");
  if (!trimmed || RESERVED_NAMES.has(trimmed.toLowerCase())) return "";
  return trimmed;
}

// Valid exactly when sanitizing is a no-op: the live input filter lets
// through characters that combine into names this refuses.
export function isValidWorktreeDirName(name: string): boolean {
  return name.length > 0 && sanitizeBranchForPath(name) === name;
}

// The folder a worktree converted into a managed one is given: its
// branch's, or a detached one's short hash as it is. Empty for a branch
// that sanitizes to nothing, which gets a generated name.
export function adoptedDirName(worktree: {
  readonly branch: string;
  readonly detached: boolean;
}): string {
  return worktree.detached
    ? worktree.branch
    : sanitizeBranchForPath(worktree.branch);
}
