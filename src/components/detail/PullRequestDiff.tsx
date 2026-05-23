import { useNavigate } from "@tanstack/react-router";
import { usePullRequestDiff } from "@/hooks/usePullRequestDiff";
import { useWorktreePullRequest } from "@/hooks/useWorktreePullRequest";
import { useWorktrees } from "@/hooks/useWorktrees";
import { pullRequestDiffRoute } from "@/router";
import { DiffNotFound, DiffView } from "./DiffView";

export function PullRequestDiff() {
  const { projectId, worktreeId } = pullRequestDiffRoute.useParams();
  const navigate = useNavigate();
  const { data: worktrees = [] } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);
  const { data: pr } = useWorktreePullRequest(
    projectId,
    worktree?.branch ?? "",
  );

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
    return <DiffNotFound onBack={goBack} message="Worktree not found." />;
  }
  if (!pr) {
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
          {pr.changedFiles} {fileNoun} into{" "}
          <span className="font-mono text-foreground/80">{pr.baseRefName}</span>
          <span className="tabular ml-3 font-mono">
            <span className="text-emerald-500">+{pr.additions}</span>{" "}
            <span className="text-rose-500">−{pr.deletions}</span>
          </span>
        </>
      }
      emptyMessage="No file changes in this PR."
    />
  );
}
