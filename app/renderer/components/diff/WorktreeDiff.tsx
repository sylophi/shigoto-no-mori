import { useScopedDeviceLabel } from "@/hooks/remote/useHostScope";
import { useSearch } from "@tanstack/react-router";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { peerReadOnlyNote } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { worktreeSyncView } from "@shigomori/ui/lib/syncState.ts";
import type { Worktree } from "@shigomori/contracts/schemas";
import { GitPageSidebar } from "@/components/worktreeDetail/git/GitPageSidebar";
import { GitPageActions } from "@/components/worktreeDetail/git/GitPageActions";
import { BranchBar } from "./BranchBar";
import { CommitComposerView } from "@shigomori/ui/views/diff/CommitComposerView.tsx";
import { DiffPage } from "./DiffPage";
import { WorktreeDiffSubtitleView } from "@shigomori/ui/views/diff/DiffTitlesView.tsx";
import {
  ChangesFooterView,
  CleanTreeMessageView,
} from "@shigomori/ui/views/diff/WorktreeDiffView.tsx";
import { LastCommitStripView } from "@shigomori/ui/views/diff/LastCommitStripView.tsx";
import { WorktreeMissingView } from "@shigomori/ui/views/shared/WorktreeMissingView.tsx";
import { useChangesActions } from "./useChangesActions";

export function WorktreeDiff() {
  const { projectId, worktreeId, nav, worktree, goBack, missing } =
    useRouteWorktree();
  // Read non-strictly like the params, which the worktree pages share.
  const { amend } = useSearch({ strict: false }) as { amend?: true };
  // Amend mode lives in the route's search param, so the page and the
  // row menu that opens it agree on one source of truth.
  const setAmending = (on: boolean) =>
    nav.toDiff(projectId, worktreeId, { amend: on, replace: true });

  if (!worktree) {
    return <WorktreeMissingView {...missing} />;
  }

  return (
    <WorktreeChanges
      worktree={worktree}
      onBack={goBack}
      amendRequested={amend === true}
      setAmending={setAmending}
    />
  );
}

// The uncommitted-changes page: the diff, with the file list turned into a
// GitHub-Desktop-style changes list (tick what goes in, discard what
// doesn't) and the commit composer under it. Split from the route
// component so the change hooks only mount once the worktree resolved.
// On a peer that takes no commands from here, the list only reads and
// the composer gives way to the read-only note.
function WorktreeChanges({
  worktree,
  onBack,
  amendRequested,
  setAmending,
}: {
  worktree: Worktree;
  onBack: () => void;
  amendRequested: boolean;
  setAmending: (on: boolean) => void;
}) {
  const deviceLabel = useScopedDeviceLabel();
  const { diff, changedCount, controls, sendShortcut, lastCommit, composer } =
    useChangesActions(worktree, amendRequested, setAmending);

  return (
    <DiffPage
      diff={diff}
      onBack={onBack}
      worktree={worktree}
      title="Uncommitted changes"
      subtitle={
        <WorktreeDiffSubtitleView
          changedCount={changedCount}
          worktreeName={worktree.name}
        />
      }
      emptyMessage={
        controls.failed ? (
          "Couldn't read the changes."
        ) : (
          <CleanTreeMessageView
            owed={worktreeSyncView(worktree).owed}
            shortcut={sendShortcut}
          />
        )
      }
      changes={controls}
      sidebarActions={<GitPageActions worktree={worktree} />}
      renderSidebar={(fileList) => (
        <GitPageSidebar worktree={worktree} tab="changes" changes={fileList} />
      )}
      footer={
        <ChangesFooterView
          branchBar={<BranchBar worktree={worktree} />}
          lastCommit={lastCommit && <LastCommitStripView {...lastCommit} />}
          composer={composer && <CommitComposerView {...composer} />}
          readOnlyNote={
            controls.readOnly ? peerReadOnlyNote(deviceLabel) : null
          }
        />
      }
    />
  );
}
