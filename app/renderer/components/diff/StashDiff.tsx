import { RelativeDate } from "@/components/ui/relative-date";
import { WorktreeMissing } from "@/components/shared/WorktreeMissing";
import { GitPageSidebar } from "@/components/worktreeDetail/git/GitPageSidebar";
import { StashMoves } from "@/components/worktreeDetail/git/StashMoves";
import { useWorktreeStashes } from "@/hooks/worktrees/useGitHistory";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useStashDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { DiffView } from "./DiffView";

// The Git page's Stashes tab: the branch's stashes in the sidebar, the
// picked one's contents and moves in the pane.
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
        stash ? (stash.named ? stash.message : "Stashed changes") : "Stash"
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
      emptyMessage="This stash holds no file changes."
    />
  );
}
