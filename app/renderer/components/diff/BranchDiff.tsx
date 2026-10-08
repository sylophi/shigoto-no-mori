import { WorktreeMissing } from "@/components/shared/WorktreeMissing";
import { useBranchHistory } from "@/hooks/git/useBranchCommits";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useBranchDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { pluralize } from "@/lib/pluralize";
import { GitPageSidebar } from "@/components/worktreeDetail/git/GitPageSidebar";
import { DiffView } from "./DiffView";

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
    return <WorktreeMissing {...missing} />;
  }

  const commits = history?.commits.length;
  return (
    <DiffView
      diff={diff}
      onBack={goBack}
      worktree={worktree}
      title="Everything this branch changes"
      subtitle={
        <>
          {commits !== undefined && `${pluralize(commits, "commit")} since `}
          <span className="font-mono">
            {history?.base?.ref ?? worktree.primaryRef}
          </span>
        </>
      }
      renderSidebar={() => (
        <GitPageSidebar worktree={worktree} tab="history" selected="branch" />
      )}
      emptyMessage="This branch changes nothing yet."
    />
  );
}
