import type { CommitSummary, Worktree } from "@shared/schemas";

// What the worktree page's Commits section shows of a branch: its
// latest commits, whether there are more behind "Show all", and
// whether to offer catching up with the primary branch.
export function commitsTeaser(worktree: Worktree): {
  commits: CommitSummary[];
  showAll: boolean;
  showPrimarySync: boolean;
} {
  return {
    // The backend hands back up to 4 rows: 3 for the teaser plus 1
    // extra as the "more available" probe.
    commits: worktree.recentCommits.slice(0, 3),
    showAll: worktree.recentCommits.length > 3,
    // Like the upstream-sync pill's dirty-state gate: rebase/merge
    // needs a clean tree, so the affordance hides instead of surfacing
    // a git failure after the click.
    showPrimarySync:
      !worktree.isPrimary &&
      !worktree.detached &&
      worktree.changedCount === 0 &&
      worktree.behindPrimary > 0,
  };
}
