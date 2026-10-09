import { RelativeDate } from "@/components/ui/relative-date";
import { WorktreeMissingView } from "@/components/shared/WorktreeMissingView";
import { useBranchHistory } from "@/hooks/git/useBranchCommits";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useCommitDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { useCommitRewrites } from "@/hooks/worktrees/useCommitRewrites";
import { NO_REWRITE } from "@/lib/commitRewrite";
import type { CommitSummary, Worktree } from "@shigomori/contracts/schemas";
import { CommitDetails, CommitSteps } from "./CommitDetails";
import { GitPageSidebar } from "@/components/worktreeDetail/git/GitPageSidebar";
import { MergeButton } from "@/components/worktreeDetail/git/MergeDialog";
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
    return <WorktreeMissingView {...missing} />;
  }

  const timeline = history?.commits ?? worktree.recentCommits;
  const index = timeline.findIndex((c) => c.hash === hash);
  // A commit off the timeline (the history before the branch, a search
  // result) carries what its row did, and one only the upstream has (its
  // side of a split) comes from the history read too. Deep-linked, the
  // hash alone is enough for the diff.
  const incoming = history?.incoming.find((c) => c.hash === hash);
  const commit =
    timeline[index] ??
    incoming ??
    worktree.recentCommits.find((c) => c.hash === hash);

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
              {" by "}
              {commit.author}, <RelativeDate date={commit.date} />
            </>
          )}
        </>
      }
      details={
        commit && (
          <TimelineCommitDetails
            worktree={worktree}
            commit={commit}
            timeline={timeline}
            index={index}
            onlyOn={incoming ? (history?.upstream ?? undefined) : undefined}
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
      sidebarActions={<MergeButton worktree={worktree} />}
      renderSidebar={() => (
        <GitPageSidebar
          worktree={worktree}
          tab="history"
          selected={`commit:${hash}`}
        />
      )}
      emptyMessage="This commit changes no files."
    />
  );
}

// The commit's details with what its place on the timeline allows. Off
// it (index -1), nothing that rewrites.
function TimelineCommitDetails({
  worktree,
  commit,
  timeline,
  index,
  onlyOn,
}: {
  worktree: Worktree;
  commit: CommitSummary;
  timeline: readonly CommitSummary[];
  index: number;
  onlyOn: string | undefined;
}) {
  const rewriteAt = useCommitRewrites(worktree, timeline);
  return (
    <CommitDetails
      worktree={worktree}
      commit={commit}
      index={index}
      onlyOn={onlyOn}
      rewrite={index >= 0 ? rewriteAt(index) : NO_REWRITE}
    />
  );
}
