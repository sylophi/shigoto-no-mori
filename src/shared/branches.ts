// Branch-name sanitization shared between main (used when creating the
// worktree directory) and renderer (used to preview the destination path
// in the new-worktree form).
//
// macOS-only target: APFS accepts Unicode (CJK, emoji, accents) just
// fine, so we only mangle what genuinely breaks as a single-segment
// directory name -- path separators and control characters. `.` and
// `..` would collide with the parent-dir references; leaving the
// result empty signals the caller to fall back to an animal name.

const PATH_SEPARATOR = /[\\/]/g;
// oxlint-disable-next-line no-control-regex -- intentional: strips control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const RESERVED_NAMES = new Set([".", ".."]);

export function sanitizeBranchForPath(branch: string): string {
  const slashed = branch
    .replace(PATH_SEPARATOR, "-")
    .replace(CONTROL_CHARS, "");
  const trimmed = slashed.replace(/^[.\s-]+|[.\s-]+$/g, "");
  if (!trimmed || RESERVED_NAMES.has(trimmed)) return "";
  return trimmed;
}
