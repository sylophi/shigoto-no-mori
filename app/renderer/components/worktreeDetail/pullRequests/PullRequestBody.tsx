import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shared/schemas";
import { usePullRequestStack } from "@/hooks/pullRequests/usePullRequestStack";
import { ClosedPullRequestBox } from "./ClosedPullRequestBox";
import { MergedPrimaryBranchBox } from "./MergedPrimaryBranchBox";
import { MergeBox } from "./MergeBox";

// What to do about the PR: merge it, or clean up after it. What the
// PR is comes before it, from whoever places it (PullRequestSection,
// or the page's PR header above PullRequestLead).
export function PullRequestBody({
  worktree,
  pr,
  repoConfig,
  lastMergeMethod,
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
  repoConfig: RepoMergeConfig | null;
  lastMergeMethod: MergeMethod | undefined;
}) {
  const isOpen = pr.state === "OPEN";
  const stack = usePullRequestStack(worktree.projectId, worktree.branch);

  return (
    <div className="space-y-4">
      {isOpen && (
        <MergeBox
          worktree={worktree}
          pr={pr}
          repoConfig={repoConfig}
          lastMergeMethod={lastMergeMethod}
          stack={stack}
        />
      )}
      {!isOpen && !worktree.isPrimary && (
        <ClosedPullRequestBox worktree={worktree} stack={stack} />
      )}
      {pr.state === "MERGED" && worktree.isPrimary && (
        <MergedPrimaryBranchBox worktree={worktree} />
      )}
    </div>
  );
}
