import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shared/schemas";
import { usePullRequestStack } from "@/hooks/pullRequests/usePullRequestStack";
import { ChecksRow } from "./ChecksRow";
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
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
  repoConfig: RepoMergeConfig | null;
  lastMergeMethod: MergeMethod | undefined;
}) {
  const isOpen = pr.state === "OPEN";
  const hasChecks = pr.checks.total > 0;
  const stack = usePullRequestStack(worktree.projectId, worktree.branch);

  return (
    <div className="space-y-4">
      <PullRequestIdentity worktree={worktree} pr={pr} />
      {stack && <StackList worktree={worktree} stack={stack} />}
      {isOpen && hasChecks && (
        <div className="-mx-2">
          <ChecksRow pr={pr} />
        </div>
      )}
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
        <ClosedPullRequestBox worktree={worktree} />
      )}
      {pr.state === "MERGED" && worktree.isPrimary && (
        <MergedPrimaryBranchBox worktree={worktree} />
      )}
    </div>
  );
}
