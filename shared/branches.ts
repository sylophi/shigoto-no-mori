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
// Checked against the lowercased name -- the CLI matches its keywords
// case-insensitively, so "Root" must be reserved too.
const RESERVED_NAMES = new Set([".", "..", "root", "primary"]);

export function sanitizeBranchForPath(branch: string): string {
  const slashed = branch
    .replace(PATH_SEPARATOR, "-")
    .replace(CONTROL_CHARS, "");
  const trimmed = slashed.replace(/^[.\s-]+|[.\s-]+$/g, "");
  if (!trimmed || RESERVED_NAMES.has(trimmed.toLowerCase())) return "";
  return trimmed;
}

// Live sanitizer for branch-name text inputs. Forward slashes stay valid
// (git uses them for namespaces like feat/foo); anything else outside the
// safe set becomes a dash so a stray space or punctuation can't smuggle in
// a ref git will refuse. A leading dash survives editing (stripping it
// live would eat an interior dash whose prefix was just deleted); names
// that still start with "-" at submit are rejected by the IPC schemas,
// matching git's own check-ref-format rule.
const INVALID_BRANCH_INPUT_CHARS = /[^A-Za-z0-9._/-]/g;

export function sanitizeBranchName(name: string): string {
  return name.replace(INVALID_BRANCH_INPUT_CHARS, "-");
}

// Live sanitizer for worktree-folder-name text inputs. Same safe set as
// branch names but forward slashes are out too — a folder name is a
// single path segment, so `/` would smuggle in a subdirectory.
const INVALID_WORKTREE_NAME_INPUT_CHARS = /[^A-Za-z0-9._-]/g;

export function sanitizeWorktreeNameInput(name: string): string {
  return name.replace(INVALID_WORKTREE_NAME_INPUT_CHARS, "-");
}

// Submit-time check for user-typed worktree folder names: valid exactly
// when sanitizing is a no-op. The live input filter above allows
// individually-legal characters that combine into names we refuse
// ("..", "root", a trailing dot).
export function isValidWorktreeDirName(name: string): boolean {
  return name.length > 0 && sanitizeBranchForPath(name) === name;
}

// Local branch names a fork PR head can land on, in the order the
// resolver tries them (pickForkBranchName in
// host/lib/githubCli/pullRequestCheckout.ts). A fork head is named by
// its author, so collisions with local branches are routine --
// "patch-1", or "main" when the PR was opened off the fork's default
// branch -- hence the owner-prefixed fallback. Shared so the form's
// "already checked out" check can't drift from what the resolver
// actually picks.
export function forkBranchCandidates(
  number: number,
  headRefName: string,
  owner: string | null | undefined,
): string[] {
  return [
    headRefName,
    owner ? `${owner}-${headRefName}` : `pr-${number}-${headRefName}`,
  ];
}
