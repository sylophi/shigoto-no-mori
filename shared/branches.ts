// Branch-name sanitization shared between main (used when creating the
// worktree directory) and renderer (used to preview the destination path
// in the new-worktree form).
//
// Unicode (CJK, emoji, accents) passes through untouched; we only mangle
// what genuinely breaks as a single-segment directory name somewhere we
// run. That means path separators and control characters everywhere,
// plus the characters NTFS refuses (< > : " | ? *) -- applied on every
// platform so the same branch names the same directory on macOS and
// Windows. `.`/`..` would collide with the parent-dir references, and
// Windows reserves the DOS device names (CON, NUL, COM1…) as filenames;
// leaving the result empty signals the caller to fall back to an animal
// name.

const PATH_SEPARATOR = /[\\/]/g;
// oxlint-disable-next-line no-control-regex -- intentional: strips control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const NTFS_ILLEGAL = /[<>:"|?*]/g;
const RESERVED_NAMES = new Set([".", ".."]);
// Case-insensitive DOS device names, reserved with or without an
// extension ("con", "con.txt").
const DOS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export function sanitizeBranchForPath(branch: string): string {
  const slashed = branch
    .replace(PATH_SEPARATOR, "-")
    .replace(NTFS_ILLEGAL, "-")
    .replace(CONTROL_CHARS, "");
  const trimmed = slashed.replace(/^[.\s-]+|[.\s-]+$/g, "");
  if (!trimmed || RESERVED_NAMES.has(trimmed)) return "";
  if (DOS_DEVICE_NAMES.test(trimmed)) return "";
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
// individually-legal characters that combine into names no platform
// should get ("con", "foo." — Win32 strips the trailing dot on create,
// so the dir on disk wouldn't match the name we asked for).
export function isValidWorktreeDirName(name: string): boolean {
  return name.length > 0 && sanitizeBranchForPath(name) === name;
}
