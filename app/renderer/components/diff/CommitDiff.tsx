import { RelativeDate } from "@/components/ui/relative-date";
import { WorktreeMissing } from "@/components/shared/WorktreeMissing";
import { useBranchHistory } from "@/hooks/git/useBranchCommits";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useCommitDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { commitRewriteAt, NO_REWRITE } from "@/lib/commitRewrite";
import { CommitDetails, CommitSteps } from "./CommitDetails";
import { DiffView } from "./DiffView";

export function CommitDiff() {
  const { projectId, hash, worktree, goBack, missing } = useRouteWorktree();
  const diff = useCommitDiff(projectId, worktree?.id, hash);
  // The commits the worktree's Git timeline shows (the same query, so
  // it's cached), for the commit's place among them: what may be
  // rewritten from it, and the steps to its neighbours.
  const { data: history } = useBranchHistory(
    projectId,
    worktree?.id,
    worktree?.recentCommits[0]?.hash,
  );

  if (!worktree) {
    return <WorktreeMissing {...missing} />;
  }

  const timeline = history?.commits ?? worktree.recentCommits;
  const index = timeline.findIndex((c) => c.hash === hash);
  // A commit off the timeline (the history before the branch, a search
  // result) carries what its row did. Deep-linked, the hash alone is
  // enough for the diff.
  const commit =
    timeline[index] ?? worktree.recentCommits.find((c) => c.hash === hash);

  return (
    <DiffView
      diff={diff}
      onBack={goBack}
      worktree={worktree}
      title={commit?.subject ?? "Commit"}
      subtitle={
        <>
          <span className="font-mono">{hash}</span>
          {commit && (
            <>
              {" · "}
              {commit.author}
              {" · "}
              <RelativeDate date={commit.date} />
            </>
          )}
        </>
      }
      details={
        commit && (
          <CommitDetails
            worktree={worktree}
            commit={commit}
            index={index}
            rewrite={
              index >= 0
                ? commitRewriteAt(worktree, timeline, index)
                : NO_REWRITE
            }
          />
        )
      }
      steps={
        index >= 0 &&
        timeline.length > 1 && (
          <CommitSteps
            worktree={worktree}
            newer={timeline[index - 1]?.hash}
            older={timeline[index + 1]?.hash}
          />
        )
      }
      // Merge commits show empty by default (git's combined diff is empty
      // when --cc/-m aren't passed). Note it explicitly so the page
      // doesn't look broken.
      emptyMessage="No file changes to show. Merge commits render empty by default."
    />
  );
}
