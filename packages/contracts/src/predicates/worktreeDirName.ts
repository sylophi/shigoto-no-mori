// Branch-name sanitization shared between main (used when creating the
// worktree directory) and renderer (used to preview the destination path
// in the new-worktree form).
//
// Unicode (CJK, emoji, accents) passes through untouched; we only mangle
// what genuinely breaks as a single-segment directory name: path
// separators (plus `:`, which Finder treats as one), and control
// characters. `.`/`..` would collide with the parent-dir references,
// and `root`/`primary` are the CLI's address keywords for the primary
// checkout (`sm cd root`) so no managed worktree may carry them;
// leaving the result empty signals the caller to fall back to an animal
// name.

const PATH_SEPARATOR = /[/:]/g;
// oxlint-disable-next-line no-control-regex -- intentional: strips control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
// Checked against the lowercased name. The CLI matches its keywords
// case-insensitively, so "Root" must be reserved too.
const RESERVED_NAMES = new Set([".", "..", "root", "primary"]);

export function sanitizeBranchForPath(branch: string): string {
  const slashed = branch
    .replace(PATH_SEPARATOR, "-")
    .replace(CONTROL_CHARS, "");
  // Dots, dashes and ASCII whitespace (Go's \s, which the CLI trims).
  const trimmed = slashed.replace(/^[.\t\n\f\r -]+|[.\t\n\f\r -]+$/g, "");
  if (!trimmed || RESERVED_NAMES.has(trimmed.toLowerCase())) return "";
  return trimmed;
}

// Submit-time check for user-typed worktree folder names: valid exactly
// when sanitizing is a no-op. The live input filter
// (sanitizeWorktreeNameInput in app/shared/git/branches.ts) allows
// individually-legal characters that combine into names we refuse
// ("..", "root", a trailing dot).
export function isValidWorktreeDirName(name: string): boolean {
  return name.length > 0 && sanitizeBranchForPath(name) === name;
}
