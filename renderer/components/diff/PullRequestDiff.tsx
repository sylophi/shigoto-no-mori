import { usePullRequestDiff } from "@/hooks/pullRequests/usePullRequestDiff";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { DiffNotFound } from "./DiffNotFound";
import { DiffView } from "./DiffView";
import { WorktreeMissing } from "./WorktreeMissing";
import { DiffStats } from "@/components/ui/diff-stats";

export function PullRequestDiff() {
  const { projectId, worktree, goBack, missing } = useRouteWorktree();
  const {
    data: pr,
    isPending: prPending,
    isError: prError,
    refetch: refetchPullRequest,
  } = useWorktreePullRequest(projectId, worktree?.branch ?? "");

  const {
    data: patch,
    isLoading,
    error,
  } = usePullRequestDiff(projectId, pr?.number);

  if (!worktree) {
    return <WorktreeMissing {...missing} message="Worktree not found." />;
  }
  if (!pr) {
    // Same story for the PR lookup: pending or failed both leave `pr`
    // undefined, and neither means the branch has no pull request. The
    // lookup shells out to `gh`, which can hang on a slow network, so
    // the pending state keeps the back button instead of a blank pane.
    if (prPending) {
      return <DiffNotFound onBack={goBack} message="Loading pull request…" />;
    }
    if (prError) {
      return (
        <DiffNotFound
          onBack={goBack}
          message="Couldn't load the pull request."
          action={{ label: "Retry", onClick: () => void refetchPullRequest() }}
        />
      );
    }
    return (
      <DiffNotFound
        onBack={goBack}
        message="No pull request found for this branch."
      />
    );
  }

  const fileNoun = pr.changedFiles === 1 ? "file" : "files";

  return (
    <DiffView
      patch={patch}
      isLoading={isLoading}
      error={error}
      onBack={goBack}
      backLabel={worktree.branch}
      title={
        <>
          {pr.title}{" "}
          <span className="font-normal text-muted-foreground/60">
            #{pr.number}
          </span>
        </>
      }
      subtitle={
        <>
          {pr.changedFiles} {fileNoun} changed into{" "}
          <span className="font-mono text-foreground/80">{pr.baseRefName}</span>
          {", "}
          <DiffStats additions={pr.additions} deletions={pr.deletions} />
        </>
      }
      emptyMessage="No file changes in this PR."
    />
  );
}
