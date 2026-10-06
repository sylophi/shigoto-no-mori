import { useProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { mappedPullRequest, worktreeTitle } from "@/lib/worktreeTitle";
import type { Worktree } from "@shared/schemas";

// The open worktree's title and description, the pull request's once
// it has one (worktreeTitle). The project map knows a PR's title before
// the page's own lookup answers, but only that lookup brings the body,
// so a worktree with a PR shows no description until it does rather
// than flash the local one it is about to replace.
export function useWorktreeTitle(worktree: Worktree): {
  title: string | null;
  description: string | null;
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
  return {
    title: worktreeTitle(worktree, pr),
    description: pr
      ? detail?.body?.trim() || null
      : (worktree.description ?? null),
  };
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
