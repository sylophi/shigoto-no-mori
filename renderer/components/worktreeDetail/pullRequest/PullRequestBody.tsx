import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shared/schemas";
import { ChecksRow } from "./ChecksRow";
import { ClosedPullRequestBox } from "./ClosedPullRequestBox";
import { MergeBox } from "./MergeBox";
import { PullRequestIdentity } from "./PullRequestIdentity";

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

  return (
    <div className="space-y-4">
      <PullRequestIdentity worktree={worktree} pr={pr} />
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
        />
      )}
      {!isOpen && !worktree.isPrimary && (
        <ClosedPullRequestBox worktree={worktree} />
      )}
    </div>
  );
}
