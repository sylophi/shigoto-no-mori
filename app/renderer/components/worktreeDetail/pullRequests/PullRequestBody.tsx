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
import { pullRequestFollowUp } from "./pullRequestFollowUp";
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
  const followUp = pullRequestFollowUp(pr, worktree);
  const stack = usePullRequestStack(worktree.projectId, worktree.branch);

  return (
    <>
      <PullRequestIdentity worktree={worktree} pr={pr} />
      {stack && <StackList worktree={worktree} stack={stack} />}
      {followUp === "merge" && (
        <MergeBox
          worktree={worktree}
          pr={pr}
          repoConfig={repoConfig}
          lastMergeMethod={lastMergeMethod}
          stack={stack}
        />
      )}
      {followUp === "cleanUp" && (
        <ClosedPullRequestBox worktree={worktree} stack={stack} />
      )}
      {followUp === "catchUpPrimary" && (
        <MergedPrimaryBranchBox worktree={worktree} />
      )}
    </>
  );
}
