import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useCommitDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { DiffView } from "./DiffView";
import { WorktreeMissing } from "./WorktreeMissing";

export function CommitDiff() {
  const { projectId, hash, worktree, goBack, missing } = useRouteWorktree();

  // Resolve commit metadata from the worktree's recentCommits cache so the
  // header shows author/subject without an extra IPC round-trip. If it's
  // not in the cache (e.g. user deep-linked) we still render the diff. The
  // hash alone is enough for git show.
  const commit = worktree?.recentCommits.find((c) => c.hash === hash);
  const {
    data: patch,
    isLoading,
    error,
  } = useCommitDiff(projectId, worktree?.id, hash);

  if (!worktree) {
    return <WorktreeMissing {...missing} message="Worktree not found." />;
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
      // when --cc/-m aren't passed). Note it explicitly so the page
      // doesn't look broken.
      emptyMessage="No file changes to show. Merge commits render empty by default."
    />
  );
}
