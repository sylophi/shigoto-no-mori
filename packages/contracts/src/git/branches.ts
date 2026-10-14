import { isValidWorktreeDirName } from "../predicates/worktreeDirName.ts";

// For live input. A leading dash survives editing (stripping it would eat
// an interior dash whose prefix was just deleted); the schemas refuse it
// at submit.
const INVALID_BRANCH_INPUT_CHARS = /[^A-Za-z0-9._/-]/g;

export function sanitizeBranchName(name: string): string {
  return name.replace(INVALID_BRANCH_INPUT_CHARS, "-");
}

// No `/`: a folder name is one path segment.
const INVALID_WORKTREE_NAME_INPUT_CHARS = /[^A-Za-z0-9._-]/g;

export function sanitizeWorktreeNameInput(name: string): string {
  return name.replace(INVALID_WORKTREE_NAME_INPUT_CHARS, "-");
}

// The renderer can't see the remote list, so this drops the first
// segment of refs in the project's remote-ref list.
export function localBranchOf(
  ref: string,
  remoteRefs: ReadonlySet<string>,
): string {
  return remoteRefs.has(ref) ? ref.replace(/^[^/]+\//, "") : ref;
}

// In the resolver's order (pickForkBranchName). A fork head is named by
// its author, so collisions are routine, hence the owner-prefixed
// fallback.
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

// A primary is on the main line, which the other device's primary
// almost always holds, and git allows a branch in one worktree at a time.
// So the copy takes mirror/<branch>, which the follower reads as the same
// branch.
const MIRROR_BRANCH_PREFIX = "mirror/";

export function mirrorBranchFor(branch: string): string {
  return `${MIRROR_BRANCH_PREFIX}${branch}`;
}

// Null without the prefix: following that branch would move the
// original's primary onto it and bounce the copy onto its mirror.
export function originalBranchOf(mirrorBranch: string): string | null {
  return mirrorBranch.startsWith(MIRROR_BRANCH_PREFIX)
    ? mirrorBranch.slice(MIRROR_BRANCH_PREFIX.length)
    : null;
}

export function pullLandingBranch(worktree: {
  branch: string;
  isPrimary: boolean;
}): string {
  return worktree.isPrimary
    ? mirrorBranchFor(worktree.branch)
    : worktree.branch;
}

// The source's folder name, so the two sides read as one worktree, or
// mirror-<name> for a primary. Undefined when it isn't a valid managed
// dirname: the create picks a fresh name.
export function pullWorktreeName(worktree: {
  name: string;
  isPrimary: boolean;
}): string | undefined {
  const name = worktree.isPrimary ? `mirror-${worktree.name}` : worktree.name;
  return isValidWorktreeDirName(name) ? name : undefined;
}
