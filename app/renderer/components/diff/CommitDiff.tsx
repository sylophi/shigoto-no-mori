import { WorktreeMissingView } from "@shigomori/ui/views/shared/WorktreeMissingView.tsx";
import {
  useBranchHistory,
  useCommitSummary,
} from "@/hooks/git/useBranchCommits";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useCommitDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { useCommitRewrites } from "@/hooks/worktrees/useCommitRewrites";
import { NO_REWRITE } from "@shigomori/ui/lib/commitRewrite.ts";
import type { CommitSummary, Worktree } from "@shigomori/contracts/schemas";
import { CommitDetails } from "./CommitDetails";
import { GitPageSidebar } from "@/components/worktreeDetail/git/GitPageSidebar";
import { GitPageActions } from "@/components/worktreeDetail/git/GitPageActions";
import { DiffPage } from "./DiffPage";
import { CommitBylineView } from "@shigomori/ui/views/diff/DiffTitlesView.tsx";

export function CommitDiff() {
  const { projectId, hash, worktree, goBack, missing } = useRouteWorktree();
  const diff = useCommitDiff(projectId, worktree?.id, hash);
  // The commits the worktree's Git timeline shows (the same view, so
  // it's cached), for the commit's place among them: what may be
  // rewritten from it.
  const { data: history } = useBranchHistory(projectId, worktree?.id);
  const recent = worktree?.recentCommits ?? [];
  const timeline = history?.commits ?? recent;
  const index = timeline.findIndex((c) => c.hash === hash);
  // One only the upstream has (its side of a split) comes from the
  // history read too. Any other off the timeline (the history before
  // the branch, a search result, one HEAD moved away from, a deep link)
  // is read by its hash.
  const incoming = history?.incoming.find((c) => c.hash === hash);
  const listed =
    timeline[index] ?? incoming ?? recent.find((c) => c.hash === hash);
  const { data: read } = useCommitSummary(
    projectId,
    worktree?.id,
    hash,
    listed === undefined,
  );
  const commit = listed ?? read ?? undefined;

  if (!worktree) {
    return <WorktreeMissingView {...missing} />;
  }

  return (
    <DiffPage
      diff={diff}
      onBack={goBack}
      worktree={worktree}
      title={commit?.subject ?? "Commit"}
      // A known commit's hash ends its details' row of buttons.
      subtitle={<CommitBylineView commit={commit} hash={hash} />}
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
      sidebarActions={<GitPageActions worktree={worktree} />}
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
