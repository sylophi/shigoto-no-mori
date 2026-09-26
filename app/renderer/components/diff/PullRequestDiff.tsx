import { usePullRequestDiff } from "@/hooks/pullRequests/usePullRequestDiff";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { SubPageNotFound } from "@/components/shared/SubPageNotFound";
import { DiffView } from "./DiffView";
import { WorktreeMissing } from "@/components/shared/WorktreeMissing";
import { DiffStats } from "@/components/ui/diff-stats";
import { pluralize } from "@/lib/pluralize";

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
    return <WorktreeMissing {...missing} />;
  }
  if (!pr) {
    // Same story for the PR lookup: pending or failed both leave `pr`
    // undefined, and neither means the branch has no pull request. The
    // lookup shells out to `gh`, which can hang on a slow network, so
    // the pending state keeps the back button instead of a blank pane.
    return (
      <SubPageNotFound
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
    <DiffView
      diff={diff}
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
          {pluralize(pr.changedFiles, "file")} changed into{" "}
          <span className="font-mono text-foreground/80">{pr.baseRefName}</span>
          {", "}
          <DiffStats additions={pr.additions} deletions={pr.deletions} />
        </>
      }
      emptyMessage="No file changes in this PR."
    />
  );
}
