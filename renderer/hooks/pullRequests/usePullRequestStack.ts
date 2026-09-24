// The stack a worktree's PR sits in, read off the project-wide PR map
// the sidebar already holds (shared/pullRequestStack.ts), so no extra
// gh call: the sweep's map carries every PR's base. The trunk is the
// project's primary checkout's branch, which keeps a long-lived
// "main -> production" PR from reading as the bottom of every stack.
import {
  pullRequestStackFor,
  trunkOf,
  type PullRequestStack,
} from "@shared/pullRequestStack";
import { useProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";

export function usePullRequestStack(
  projectId: string,
  branch: string,
): PullRequestStack | null {
  const { data: prs } = useProjectPullRequests(projectId);
  const { data: worktrees } = useWorktrees(projectId);
  return prs ? pullRequestStackFor(prs, branch, trunkOf(worktrees)) : null;
}
