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
import { PullRequestIdentity } from "./PullRequestIdentity";
import { StackList } from "./StackList";

export function PullRequestBody({
  worktree,
  pr,
  repoConfig,
  lastMergeMethod,
  headed = false,
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
  repoConfig: RepoMergeConfig | null;
  lastMergeMethod: MergeMethod | undefined;
  // Under the page's PR header (PullRequestLead), which already says
  // what the PR is and holds its stack.
  headed?: boolean;
}) {
  const isOpen = pr.state === "OPEN";
  const stack = usePullRequestStack(worktree.projectId, worktree.branch);

  return (
    <div className="space-y-4">
      {!headed && <PullRequestIdentity worktree={worktree} pr={pr} />}
      {stack && !headed && <StackList worktree={worktree} stack={stack} />}
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
