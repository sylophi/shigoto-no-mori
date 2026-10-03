import { useState } from "react";
import { useUndoCommits } from "@/hooks/worktrees/useUndoCommits";
import { commitRewriteAt } from "@/lib/commitRewrite";
import type { Worktree } from "@shared/schemas";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { WorktreePrimarySyncPill } from "../WorktreePrimarySyncPill";
import { WorktreeSyncPill } from "../WorktreeSyncPill";
import { BranchHistoryDrawer } from "../branch/BranchHistoryDrawer";
import { CommitRow } from "./CommitRow";
import { CommitsSectionView } from "./CommitsSectionView";
import { commitsTeaser } from "./commitsTeaser";

export function CommitsSection({ worktree }: { worktree: Worktree }) {
  const nav = useWorktreeNav();
  const { commits, showAll, showPrimarySync } = commitsTeaser(worktree);
  const [historyOpen, setHistoryOpen] = useState(false);
  const undo = useUndoCommits(worktree);
  return (
    <CommitsSectionView
      changedCount={worktree.changedCount}
      onOpenChanges={() => nav.toDiff(worktree.projectId, worktree.id)}
      syncPill={<WorktreeSyncPill worktree={worktree} />}
      commits={commits}
      renderCommit={(commit, index) => (
        <CommitRow
          worktree={worktree}
          commit={commit}
          rewrite={commitRewriteAt(worktree, worktree.recentCommits, index)}
          onUndo={undo.undoTo}
          undoPending={undo.pending}
        />
      )}
      primarySync={
        showPrimarySync && <WorktreePrimarySyncPill worktree={worktree} />
      }
      showAll={showAll}
      onShowAll={() => setHistoryOpen(true)}
      drawer={
        <BranchHistoryDrawer
          worktree={worktree}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
        />
      }
    />
  );
}
