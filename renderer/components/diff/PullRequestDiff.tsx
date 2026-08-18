import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { usePullRequestDiff } from "@/hooks/pullRequests/usePullRequestDiff";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { DiffNotFound } from "./DiffNotFound";
import { DiffView } from "./DiffView";

const route = getRouteApi("/projects/$projectId/worktrees/$worktreeId/pr-diff");

export function PullRequestDiff() {
  const { projectId, worktreeId } = route.useParams();
  const navigate = useNavigate();
  const {
    data: worktrees = [],
    isPending: worktreesPending,
    isError: worktreesError,
    refetch: refetchWorktrees,
  } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);
  const {
    data: pr,
    isPending: prPending,
    isError: prError,
    refetch: refetchPullRequest,
  } = useWorktreePullRequest(projectId, worktree?.branch ?? "");

  const goBack = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId",
      params: { projectId, worktreeId },
    });

  const {
    data: patch,
    isLoading,
    error,
  } = usePullRequestDiff(projectId, pr?.number);

  if (!worktree) {
    // Cold cache (e.g. a reload landing directly on this route): the
    // list hasn't resolved yet, so absence doesn't mean missing.
    if (worktreesPending) return null;
    // The list query is silent on error, so without this branch a
    // failed listing reads as a deleted worktree.
    if (worktreesError) {
      return (
        <DiffNotFound
          onBack={goBack}
          message="Couldn't load worktrees."
          action={{ label: "Retry", onClick: () => void refetchWorktrees() }}
        />
      );
    }
    return <DiffNotFound onBack={goBack} message="Worktree not found." />;
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
          <span className="font-mono text-emerald-500">
            +{pr.additions}
          </span>{" "}
          <span className="font-mono text-rose-500">−{pr.deletions}</span>
        </>
      }
      emptyMessage="No file changes in this PR."
    />
  );
}
