// What a Tidy pass learns about a worktree: its commits against the
// primary branch and its size on disk. The fake host has no hygiene
// channel, so these are for a picture of the page (../scenes): a branch
// whose pull request merged reads as merged, the rest as work still
// going, and each worktree weighs a little more than the one before.
import type {
  Worktree,
  WorktreeDiskUsage,
  WorktreeHygiene,
} from "@shigomori/contracts/schemas/index";

const MB = 1024 * 1024;

export function fakeHygiene(
  worktree: Worktree,
  merged: ReadonlySet<string>,
): WorktreeHygiene {
  const [head] = worktree.recentCommits;
  return {
    worktreeId: worktree.id,
    lastCommitAt: head ? Date.parse(head.date) : null,
    headHash: head?.hash ?? null,
    uniqueCommits: merged.has(worktree.branch) ? 0 : worktree.ahead + 1,
    contentAlreadyInPrimary: false,
    primaryRef: "origin/main",
    holdsPrimaryBranch: worktree.branch === "main",
    untracked: false,
  };
}

export function fakeDiskUsage(
  worktree: Worktree,
  index: number,
): WorktreeDiskUsage {
  const bytes = (180 + index * 140) * MB;
  return {
    worktreeId: worktree.id,
    bytes,
    reclaimableBytes: Math.round(bytes * 0.92),
    lastActivityAt: null,
    partial: false,
  };
}
