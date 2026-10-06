import type { PullRequest, Worktree } from "@shared/schemas";

// What a worktree's work is called: its pull request's title once it
// has one, in any state, and the worktree's own (`sm describe`) before
// that. Null when it has neither, and the branch names it instead. A
// PR on the primary branch is never the checkout's own (one headed
// there comes from a fork's branch of the same name), so it doesn't
// count.
export function worktreeTitle(
  worktree: Pick<Worktree, "title" | "branch" | "primaryBranch">,
  pr: Pick<PullRequest, "title"> | null | undefined,
): string | null {
  return pr && worktree.branch !== worktree.primaryBranch
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
