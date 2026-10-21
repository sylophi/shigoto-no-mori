import {
  isFromThisRepository,
  type PullRequest,
  type Worktree,
} from "@shigomori/contracts/schemas";

type TitledWorktree = Pick<Worktree, "title" | "branch" | "primaryBranch">;
type TitlePullRequest = Pick<
  PullRequest,
  "title" | "state" | "isCrossRepository"
>;

// Whether a PR found by the worktree's branch name is the worktree's
// own: one from this repository (isFromThisRepository), and not on the
// primary branch, which is never the checkout's own. A fork's PR the
// branch was checked out from doesn't count either, as for `sm
// describe`. The worktree's own PR names it in any state
// (worktreeTitle).
export function isOwnPullRequest<
  P extends Pick<PullRequest, "isCrossRepository">,
>(worktree: TitledWorktree, pr: P | null | undefined): pr is P {
  return (
    pr != null &&
    isFromThisRepository(pr) &&
    worktree.branch !== worktree.primaryBranch
  );
}

// What a worktree's work is called: its PR's title, else its own
// (`sm describe`). Null when there is neither, and the branch names it
// instead.
export function worktreeTitle(
  worktree: TitledWorktree,
  pr: TitlePullRequest | null | undefined,
): string | null {
  return isOwnPullRequest(worktree, pr) ? pr.title : (worktree.title ?? null);
}

// The worktree's PR in a project's map (keyed by head branch), none
// for a detached head.
export function mappedPullRequest(
  prs: Record<string, PullRequest> | undefined,
  worktree: Pick<Worktree, "branch" | "detached">,
): PullRequest | undefined {
  // hasOwn, since a branch can be named "constructor".
  return !worktree.detached &&
    prs !== undefined &&
    Object.hasOwn(prs, worktree.branch)
    ? prs[worktree.branch]
    : undefined;
}
