import { useRepoMergeConfig } from "@/hooks/githubCli/useRepoMergeConfig";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import type { Worktree } from "@shared/schemas";
import { PullRequestBody } from "./PullRequestBody";

// What to do about the PR under the page's header (WorktreeHeader):
// merge it, or clean up after it.
export function PullRequestLead({ worktree }: { worktree: Worktree }) {
  const { data: pr } = useWorktreePullRequest(
    worktree.projectId,
    worktree.branch,
  );
  const { data: repoConfig } = useRepoMergeConfig(worktree.projectId);
  const { data: shigomori } = useShigomoriConfig(worktree.projectId);
  if (!pr) return null;
  return (
    <PullRequestBody
      worktree={worktree}
      pr={pr}
      repoConfig={repoConfig ?? null}
      lastMergeMethod={shigomori?.lastMergeMethod}
    />
  );
}
