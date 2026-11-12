import { useSearch } from "@tanstack/react-router";
import { WorktreeMissingView } from "@shigomori/ui/views/shared/WorktreeMissingView.tsx";
import { useBranchHistory } from "@/hooks/git/useBranchCommits";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useBranchDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { BranchCombobox } from "@/components/shared/BranchCombobox";
import { GitPageSidebar } from "@/components/worktreeDetail/git/GitPageSidebar";
import { GitPageActions } from "@/components/worktreeDetail/git/GitPageActions";
import { DiffPage } from "./DiffPage";
import {
  BRANCH_DIFF_BASE_PICKER,
  BranchDiffSubtitleView,
} from "@shigomori/ui/views/diff/DiffTitlesView.tsx";

// Everything the branch changes against where it left the primary
// branch, or the ref picked in its place, its uncommitted work
// included.
export function BranchDiff() {
  const { projectId, worktree, goBack, missing } = useRouteWorktree();
  const { base: picked, list } = useSearch({ strict: false }) as {
    base?: string;
    list?: true;
  };
  const nav = useWorktreeNav();
  const diff = useBranchDiff(projectId, worktree?.id, picked);
  const { data: history } = useBranchHistory(projectId, worktree?.id);

  if (!worktree) {
    return <WorktreeMissingView {...missing} />;
  }

  const primary = history?.base?.ref ?? worktree.primaryRef;
  const base = picked ?? primary;
  return (
    <DiffPage
      diff={diff}
      onBack={goBack}
      worktree={worktree}
      title="All branch changes"
      subtitle={
        <BranchDiffSubtitleView
          commits={base === primary ? history?.commits.length : undefined}
          more={history?.more ?? false}
        />
      }
      subtitleEnd={
        <BranchCombobox
          projectId={projectId}
          value={base ?? ""}
          onChange={(next) =>
            nav.toBranchDiff(projectId, worktree.id, {
              base: next === primary ? undefined : next,
              list,
              replace: true,
            })
          }
          excludeBranches={[worktree.branch]}
          pinnedBranch={primary}
          placeholder="Base"
          className={BRANCH_DIFF_BASE_PICKER}
        />
      }
      sidebarActions={<GitPageActions worktree={worktree} />}
      renderSidebar={(files) => (
        <GitPageSidebar
          worktree={worktree}
          tab="history"
          selected="branch"
          files={files}
        />
      )}
      emptyMessage="This branch changes nothing yet."
    />
  );
}
