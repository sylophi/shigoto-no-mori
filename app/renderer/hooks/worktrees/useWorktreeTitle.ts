import { useProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import {
  isOwnPullRequest,
  mappedPullRequest,
  pullRequestOwnsTitle,
  titledByPullRequest,
  worktreeTitle,
} from "@/lib/worktreeTitle";
import type { PullRequest, PullRequestDetail, Worktree } from "@shared/schemas";

// The open worktree's title and description, its open PR's while it
// has one (worktreeTitle). The project map knows a PR's title before
// the page's own lookup answers, but only that lookup brings the body,
// so a worktree with an open PR shows no description until it does
// rather than flash the local one it is about to replace.
//
// `pullRequest` is the PR when the title is its title, so the page can
// lead with the PR itself instead of naming it twice.
export function useWorktreeTitle(worktree: Worktree): {
  title: string | null;
  description: string | null;
  pullRequest: PullRequest | PullRequestDetail | null;
} {
  const { data: detail } = useWorktreePullRequest(
    worktree.projectId,
    worktree.branch,
    { enabled: !worktree.detached },
  );
  const mapped = useMappedPullRequest(worktree);
  // The lookup's answer wins over the map's, a null included: it is
  // the fresher of the two.
  const pr = detail === undefined ? mapped : detail;
  const body = shownText(detail?.body);
  return {
    title: worktreeTitle(worktree, pr),
    description: pullRequestOwnsTitle(worktree, pr)
      ? body
      : (shownText(worktree.description) ??
        (isOwnPullRequest(worktree, pr) ? body : null)),
    pullRequest: titledByPullRequest(worktree, pr) ? pr : null,
  };
}

// Markdown that renders to something, or null: a PR template nobody
// filled in is only HTML comments, which render to nothing.
function shownText(markdown: string | undefined): string | null {
  return markdown?.replace(/<!--[\s\S]*?-->/g, "").trim() || null;
}

// The sidebar's PR for the worktree: the project map's entry for its
// branch, none for a detached head.
function useMappedPullRequest(worktree: Worktree) {
  const { data: projectPrs } = useProjectPullRequests(worktree.projectId);
  return mappedPullRequest(projectPrs, worktree);
}

// What to call the worktree where a page links back to it: its title
// as the sidebar shows it, else the branch. The project map alone, so
// a back button costs no lookup of its own.
export function useWorktreeName(worktree: Worktree): string {
  return (
    worktreeTitle(worktree, useMappedPullRequest(worktree)) ?? worktree.branch
  );
}
