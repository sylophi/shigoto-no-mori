// The worktree page's way into the Git page (GitSectionView): its
// changes, stashes and newest commits, and the moves worth a click.
import { useBranchHistory } from "@/hooks/git/useBranchCommits";
import { useWorktreeStashes } from "@/hooks/worktrees/useGitHistory";
import { useWorktreeChanges } from "@/hooks/worktrees/useWorktreeChanges";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { canSyncFromPrimary } from "@shigomori/ui/lib/syncState.ts";
import type { Worktree } from "@shigomori/contracts/schemas";
import { WorktreePrimarySyncPill } from "../WorktreePrimarySyncPill";
import { WorktreeSyncPill } from "../WorktreeSyncPill";
import { GitSectionView } from "@shigomori/ui/views/worktreeDetail/git/GitSectionView.tsx";
import { OperationBanner } from "./OperationBanner";

// How many of the newest commits the History row lists.
const SHOWN_COMMITS = 3;

export function GitSection({ worktree }: { worktree: Worktree }) {
  const nav = useWorktreeNav();
  const { projectId, id: worktreeId } = worktree;
  const { data: files = [] } = useWorktreeChanges(projectId, worktreeId);
  const { data: stashes = [] } = useWorktreeStashes(worktree);
  const { data: history } = useBranchHistory(
    projectId,
    worktreeId,
    worktree.recentCommits[0]?.hash,
  );
  return (
    <GitSectionView
      worktree={worktree}
      files={files}
      stashes={stashes}
      commits={(history?.commits ?? worktree.recentCommits).slice(
        0,
        SHOWN_COMMITS,
      )}
      branch={
        history?.base && history.commits.length > 0
          ? {
              base: history.base.ref,
              own: history.commits.length,
              more: history.more,
            }
          : undefined
      }
      syncPills={
        <>
          <WorktreeSyncPill worktree={worktree} />
          {canSyncFromPrimary(worktree) && (
            <WorktreePrimarySyncPill worktree={worktree} />
          )}
        </>
      }
      operationBanner={<OperationBanner worktree={worktree} />}
      nav={{
        toDiff: () => nav.toDiff(projectId, worktreeId),
        toStash: (hash) => nav.toStash(projectId, worktreeId, hash),
        toCommit: (hash) => nav.toCommit(projectId, worktreeId, hash),
        toBranchDiff: () => nav.toBranchDiff(projectId, worktreeId),
      }}
    />
  );
}
