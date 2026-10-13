import { useProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import {
  isOwnPullRequest,
  mappedPullRequest,
  worktreeTitle,
} from "@shigomori/ui/lib/worktreeTitle.ts";
import type {
  PullRequest,
  PullRequestDetail,
  Worktree,
} from "@shigomori/contracts/schemas";

// The open worktree's title and description: its own PR's title in
// any state (worktreeTitle), and while that PR is open its body too
// (`sm describe` edits the PR's then). Once it is merged or closed,
// the worktree's own description comes back, or the PR's body when it
// has none. The project map knows a PR's title before the page's own
// lookup answers, but only that lookup brings the body, so a worktree
// with an open PR shows no description until it does rather than
// flash the local one it is about to replace.
//
// `pullRequest` is the worktree's own PR, so the page can lead with
// the PR itself instead of naming it twice. `pullRequestBody` is the
// open PR's body as written (bodySource), template comments too: what
// an edit of the description starts from.
export function useWorktreeTitle(worktree: Worktree): {
  title: string | null;
  description: string | null;
  pullRequestBody: string | undefined;
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
  const own = isOwnPullRequest(worktree, pr) ? pr : null;
  const open = own?.state === "OPEN";
  return {
    title: worktreeTitle(worktree, pr),
    description: open
      ? body
      : (shownText(worktree.description) ?? (own ? body : null)),
    pullRequestBody: open ? (detail?.bodySource ?? detail?.body) : undefined,
    pullRequest: own,
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
