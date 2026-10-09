import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shigomori/contracts/schemas";
import { usePullRequestStack } from "@/hooks/pullRequests/usePullRequestStack";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { ClosedPullRequestBox } from "./ClosedPullRequestBox";
import { MergedPrimaryBranchBox } from "./MergedPrimaryBranchBox";
import { MergeBox } from "./MergeBox";

// What to do about the PR: merge it, or clean up after it. What the
// PR is comes before it, from whoever places it (PullRequestSection,
// or the page's header, WorktreeHeader, above PullRequestLead). A peer
// that takes no commands from here has nothing to clean up after it.
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
  const { canCommand } = useCommandAccess();

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
      {canCommand && !isOpen && !worktree.isPrimary && (
        <ClosedPullRequestBox
          // Its reach chosen afresh on another worktree's page.
          key={worktree.id}
          worktree={worktree}
          stack={stack}
        />
      )}
      {canCommand && pr.state === "MERGED" && worktree.isPrimary && (
        <MergedPrimaryBranchBox worktree={worktree} />
      )}
    </div>
  );
}
