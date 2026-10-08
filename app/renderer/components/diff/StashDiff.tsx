import { RelativeDate } from "@/components/ui/relative-date";
import { WorktreeMissing } from "@/components/shared/WorktreeMissing";
import { GitPageSidebar } from "@/components/worktreeDetail/git/GitPageSidebar";
import { StashMoves } from "@/components/worktreeDetail/git/StashMoves";
import { useWorktreeStashes } from "@/hooks/worktrees/useGitHistory";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useStashDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { DiffView } from "./DiffView";

// The Git page's Stashes tab: the branch's stashes in the sidebar, under
// the way to stash the changes, and the picked one's contents and moves
// in the pane. Without one picked (none made yet, or the last dropped)
// the pane says what a stash is for.
export function StashDiff() {
  const { projectId, hash, worktree, goBack, missing } = useRouteWorktree();
  const diff = useStashDiff(projectId, worktree?.id, hash);
  const { data: stashes = [] } = useWorktreeStashes(worktree);

  if (!worktree) {
    return <WorktreeMissing {...missing} />;
  }
  const index = stashes.findIndex((s) => s.hash === hash);
  const stash = stashes[index];

  return (
    <DiffView
      diff={diff}
      onBack={goBack}
      worktree={worktree}
      title={
        stash ? (stash.named ? stash.message : "Stashed changes") : "Stashes"
      }
      subtitle={
        stash && (
          <>
            Stashed <RelativeDate date={stash.date} />
            {!stash.named && ` on top of ${stash.message}`}
          </>
        )
      }
      details={
        stash && (
          <StashMoves
            worktree={worktree}
            stash={stash}
            next={(stashes[index + 1] ?? stashes[index - 1])?.hash}
          />
        )
      }
      renderSidebar={() => (
        <GitPageSidebar worktree={worktree} tab="stashes" selected={hash} />
      )}
      emptyMessage={
        hash
          ? "This stash holds no file changes."
          : "A stash sets your uncommitted changes aside, new files included, and leaves the worktree clean. Restore them here whenever you're ready."
      }
    />
  );
}
