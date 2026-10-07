import type { PullRequest, Worktree } from "@shared/schemas";

type TitledWorktree = Pick<Worktree, "title" | "branch" | "primaryBranch">;
type TitlePullRequest = Pick<
  PullRequest,
  "title" | "state" | "isCrossRepository"
>;

// Whether a PR found by the worktree's branch name is the worktree's
// own. The name is matched across every fork, so a fork's PR may be a
// stranger's branch of the same name, and one on the primary branch is
// never the checkout's own. Neither counts.
export function isOwnPullRequest(
  worktree: TitledWorktree,
  pr: Pick<PullRequest, "isCrossRepository"> | null | undefined,
): pr is Pick<PullRequest, "isCrossRepository"> {
  return (
    pr != null &&
    pr.isCrossRepository !== true &&
    worktree.branch !== worktree.primaryBranch
  );
}

// Whether the worktree's PR holds its title and description: while it
// is open (`sm describe` refuses changes then). A merged or closed one,
// an old PR on a reused branch name too, lets the worktree's own come
// back.
export function pullRequestOwnsTitle(
  worktree: TitledWorktree,
  pr: Pick<PullRequest, "state" | "isCrossRepository"> | null | undefined,
): boolean {
  return isOwnPullRequest(worktree, pr) && pr?.state === "OPEN";
}

// Whether the worktree is called by its PR's title (worktreeTitle):
// an open PR's always, a merged or closed one's while the worktree has
// no title of its own.
export function titledByPullRequest<P extends TitlePullRequest>(
  worktree: TitledWorktree,
  pr: P | null | undefined,
): pr is P {
  return (
    pullRequestOwnsTitle(worktree, pr) ||
    (worktree.title === undefined && isOwnPullRequest(worktree, pr))
  );
}

// What a worktree's work is called: its open PR's title, else its own
// (`sm describe`), else a merged or closed PR's. Null when there is
// none, and the branch names it instead.
export function worktreeTitle(
  worktree: TitledWorktree,
  pr: TitlePullRequest | null | undefined,
): string | null {
  return titledByPullRequest(worktree, pr)
    ? pr.title
    : (worktree.title ?? null);
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
