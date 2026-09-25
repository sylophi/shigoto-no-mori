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
// branch names but forward slashes are out too. A folder name is a
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

// The local branch a checkout of `ref` lands on: a remote-tracking ref
// ("origin/main") resolves to its local branch ("main", created as a
// tracking branch if missing), anything else is already local. The
// renderer can't see the remote list, so this approximates main's
// longest-configured-remote split by dropping the first path segment
// of refs that appear in the project's remote-ref list.
export function localBranchOf(
  ref: string,
  remoteRefs: ReadonlySet<string>,
): string {
  return remoteRefs.has(ref) ? ref.replace(/^[^/]+\//, "") : ref;
}

// Local branch names a fork PR head can land on, in the order the
// resolver tries them (pickForkBranchName in
// host/lib/githubCli/pullRequestCheckout.ts). A fork head is named by
// its author, so collisions with local branches are routine ("patch-1",
// or "main" when the PR was opened off the fork's default branch),
// hence the owner-prefixed fallback. Shared so the form's
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

// Where a mirror of a primary checkout lives on the other device. A
// primary is on the repo's main line, which that device's own primary
// almost always holds, and git allows a branch in one worktree at a
// time. So the copy takes mirror/<branch> in a mirror-<name> folder,
// and the git follower (host/mirror/gitFollow.ts) reads the two branch
// names as one: commits cross between the primary's `main` and the
// copy's `mirror/main`, and both primaries keep their branches. The
// rule holds for every branch the primary moves to, so the copy never
// collides with a branch its device holds.
const MIRROR_BRANCH_PREFIX = "mirror/";

export function mirrorBranchFor(branch: string): string {
  return `${MIRROR_BRANCH_PREFIX}${branch}`;
}

// The inverse, for the follower reading the copy's branch as the
// original's. Null for a branch without the prefix: the copy has left
// the rule, and following it would move the original's primary onto
// that branch and then bounce the copy onto its mirror.
export function originalBranchOf(mirrorBranch: string): string | null {
  return mirrorBranch.startsWith(MIRROR_BRANCH_PREFIX)
    ? mirrorBranch.slice(MIRROR_BRANCH_PREFIX.length)
    : null;
}

// The branch a pulled or sent worktree lands on: its own, or the
// mirror branch for a primary checkout.
export function pullLandingBranch(worktree: {
  branch: string;
  isPrimary: boolean;
}): string {
  return worktree.isPrimary
    ? mirrorBranchFor(worktree.branch)
    : worktree.branch;
}

// The folder a pulled or sent (transplanted or mirrored) worktree
// lands under on the other device: the source's own folder name
// (Worktree.name, the source host's basename of its path), so the two
// sides read as one worktree in every sidebar, or mirror-<name> for a
// primary (its name is the repo folder, which the other device's
// primary is usually called too). Undefined when the name would not
// be a valid managed dirname (an external worktree in an odd folder),
// in which case the create picks a fresh pool name as it always did.
// Shared so the dialogs' review and the host's send name the same
// folder.
export function pullWorktreeName(worktree: {
  name: string;
  isPrimary: boolean;
}): string | undefined {
  const name = worktree.isPrimary ? `mirror-${worktree.name}` : worktree.name;
  return isValidWorktreeDirName(name) ? name : undefined;
}
