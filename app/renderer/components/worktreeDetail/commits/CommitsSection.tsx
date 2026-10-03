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

export function CommitsSection({ worktree }: { worktree: Worktree }) {
  const nav = useWorktreeNav();
  // The backend hands back up to 4 rows: 3 for the teaser plus 1 extra
  // we use as the "more available" probe. Slicing here keeps the
  // teaser's visible shape decoupled from that probe.
  const commits = worktree.recentCommits.slice(0, 3);
  const showAll = worktree.recentCommits.length > 3;
  // Mirror the upstream-sync pill's dirty-state gate: rebase/merge
  // needs a clean tree, so hide the affordance instead of surfacing a
  // git failure after the click.
  const showPrimarySync =
    !worktree.isPrimary &&
    !worktree.detached &&
    worktree.changedCount === 0 &&
    worktree.behindPrimary > 0;
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
