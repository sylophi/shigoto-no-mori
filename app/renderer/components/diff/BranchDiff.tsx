import { WorktreeMissingView } from "@/components/shared/WorktreeMissingView";
import { useBranchHistory } from "@/hooks/git/useBranchCommits";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useBranchDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { GitPageSidebar } from "@/components/worktreeDetail/git/GitPageSidebar";
import { MergeButton } from "@/components/worktreeDetail/git/MergeDialog";
import { DiffPage } from "./DiffPage";
import { BranchDiffSubtitleView } from "./DiffTitlesView";

// Everything the branch's commits change against where it left the
// primary branch: what a pull request of it would show, with or without
// one. Uncommitted work is the changes page's.
export function BranchDiff() {
  const { projectId, worktree, goBack, missing } = useRouteWorktree();
  const diff = useBranchDiff(projectId, worktree?.id);
  const { data: history } = useBranchHistory(
    projectId,
    worktree?.id,
    worktree?.recentCommits[0]?.hash,
  );

  if (!worktree) {
    return <WorktreeMissingView {...missing} />;
  }

  const commits = history?.commits.length;
  return (
    <DiffPage
      diff={diff}
      onBack={goBack}
      worktree={worktree}
      title="All branch changes"
      subtitle={
        <BranchDiffSubtitleView
          commits={commits}
          base={history?.base?.ref ?? worktree.primaryRef}
        />
      }
      sidebarActions={<MergeButton worktree={worktree} />}
      renderSidebar={() => (
        <GitPageSidebar worktree={worktree} tab="history" selected="branch" />
      )}
      emptyMessage="This branch changes nothing yet."
    />
  );
}
