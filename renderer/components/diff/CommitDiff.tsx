import { useNavigate } from "@tanstack/react-router";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useCommitDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { commitDiffRoute } from "@/router";
import { DiffNotFound } from "./DiffNotFound";
import { DiffView } from "./DiffView";

export function CommitDiff() {
  const { projectId, worktreeId, hash } = commitDiffRoute.useParams();
  const navigate = useNavigate();
  const { data: worktrees = [], isPending } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);

  const goBack = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId",
      params: { projectId, worktreeId },
    });

  // Resolve commit metadata from the worktree's recentCommits cache so the
  // header shows author/subject without an extra IPC round-trip. If it's
  // not in the cache (e.g. user deep-linked) we still render the diff —
  // the hash alone is enough for git show.
  const commit = worktree?.recentCommits.find((c) => c.hash === hash);
  const {
    data: patch,
    isLoading,
    error,
  } = useCommitDiff(projectId, worktree?.id, hash);

  if (!worktree) {
    // Cold cache (e.g. a reload landing directly on this route): the
    // list hasn't resolved yet, so absence doesn't mean missing.
    if (isPending) return null;
    return <DiffNotFound onBack={goBack} message="Worktree not found." />;
  }

  return (
    <DiffView
      patch={patch}
      isLoading={isLoading}
      error={error}
      onBack={goBack}
      backLabel={worktree.branch}
      title={commit?.subject ?? "Commit"}
      subtitle={
        <>
          <span className="font-mono">{hash}</span>
          {commit && (
            <>
              {" · "}
              {commit.author}
            </>
          )}
        </>
      }
      // Merge commits show empty by default (git's combined diff is empty
      // when --cc/-m aren't passed) — note it explicitly so the page
      // doesn't look broken.
      emptyMessage="No file changes to show. Merge commits render empty by default."
    />
  );
}
