import { usePullRequestDiff } from "@/hooks/pullRequests/usePullRequestDiff";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { SubPageNotFoundView } from "@shigomori/ui/views/shared/SubPageNotFoundView.tsx";
import { DiffPage } from "./DiffPage";
import {
  PullRequestDiffSubtitleView,
  PullRequestDiffTitleView,
} from "./DiffTitlesView";
import { WorktreeMissingView } from "@shigomori/ui/views/shared/WorktreeMissingView.tsx";

export function PullRequestDiff() {
  const { projectId, worktree, goBack, missing } = useRouteWorktree();
  const {
    data: pr,
    isPending: prPending,
    isError: prError,
    refetch: refetchPullRequest,
  } = useWorktreePullRequest(projectId, worktree?.branch ?? "");

  const diff = usePullRequestDiff(projectId, pr?.number);

  if (!worktree) {
    return <WorktreeMissingView {...missing} />;
  }
  if (!pr) {
    // Same story for the PR lookup: pending or failed both leave `pr`
    // undefined, and neither means the branch has no pull request. The
    // lookup shells out to `gh`, which can hang on a slow network, so
    // the pending state keeps the back button instead of a blank pane.
    return (
      <SubPageNotFoundView
        onBack={goBack}
        message={
          prPending
            ? "Loading pull request…"
            : prError
              ? "Couldn't load the pull request."
              : "No pull request found for this branch."
        }
        action={
          prError
            ? { label: "Retry", onClick: () => void refetchPullRequest() }
            : undefined
        }
      />
    );
  }

  return (
    <DiffPage
      diff={diff}
      onBack={goBack}
      worktree={worktree}
      title={<PullRequestDiffTitleView title={pr.title} number={pr.number} />}
      subtitle={
        <PullRequestDiffSubtitleView
          changedFiles={pr.changedFiles}
          baseRefName={pr.baseRefName}
          additions={pr.additions}
          deletions={pr.deletions}
        />
      }
      emptyMessage="No file changes in this PR."
    />
  );
}
