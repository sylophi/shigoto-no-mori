import { useEffect, useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useFileDiff } from "@/hooks/worktrees/useWorktreeDiff";
import {
  useCommitChanges,
  useDiscardChanges,
  useDiscardHunks,
  useFileHunks,
  useRestoreDiscard,
  useSetHunksStaged,
  useSetStaged,
  useWorktreeChanges,
} from "@/hooks/worktrees/useWorktreeChanges";
import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import { useAmendDraft } from "@/hooks/worktrees/useAmendDraft";
import {
  useResolveConflict,
  useStashChanges,
} from "@/hooks/worktrees/useGitHistory";
import { useUndoCommits } from "@/hooks/worktrees/useUndoCommits";
import { EMPTY_DRAFT, useCommitDraft } from "@/lib/commitDraft";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { pluralize } from "@/lib/pluralize";
import { isOverlayOpen } from "@/lib/dom";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import { useCommitRewrites } from "@/hooks/worktrees/useCommitRewrites";
import { worktreeSyncView } from "@/lib/syncState";
import { useSyncMoveMutations } from "@/hooks/worktrees/useWorktreeSync";
import {
  changeKey,
  isUntracked,
  type Worktree,
} from "@shigomori/contracts/schemas";
import { GitPageSidebar } from "@/components/worktreeDetail/git/GitPageSidebar";
import { MergeButton } from "@/components/worktreeDetail/git/MergeDialog";
import { BranchBar } from "./BranchBar";
import {
  changedFilePaths,
  includedFiles,
  type DiffChangesControls,
} from "./changesControls";
import { CommitComposerView } from "./CommitComposerView";
import { DiffPage } from "./DiffPage";
import { WorktreeDiffSubtitleView } from "./DiffTitlesView";
import { ChangesFooterView, CleanTreeMessageView } from "./WorktreeDiffView";
import { LastCommitStripView } from "./LastCommitStripView";
import { WorktreeMissingView } from "@shigomori/ui/views/shared/WorktreeMissingView.tsx";

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
  const { canCommand } = useCommandAccess();
  const { projectId, id: worktreeId } = worktree;
  const { data: files, error: statusError } = useWorktreeChanges(
    projectId,
    worktreeId,
  );
  // The pick is held as the row's key and resolved against the live
  // list, so a file that stops being changed (discarded, committed,
  // reverted in an editor) falls back to the first row instead of
  // leaving the pane pointing at nothing.
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const picked =
    files?.find((file) => changeKey(file) === pickedKey) ?? files?.[0] ?? null;
  // Only a modified file ticks by hunk: the others are whole-file
  // changes (an addition, a removal, a rename) or a conflict.
  const hunkPath =
    picked?.kind === "modified" && !picked.conflicted ? picked.path : undefined;
  const { data: hunkStates } = useFileHunks(
    projectId,
    worktreeId,
    canCommand ? hunkPath : undefined,
  );
  const { mutate: stageHunks, isPending: stagingHunks } = useSetHunksStaged();
  const { mutate: discardHunks, isPending: discardingHunks } =
    useDiscardHunks();
  const diff = useFileDiff(
    projectId,
    worktreeId,
    picked ? changedFilePaths(picked) : [],
    picked ? isUntracked(picked) : false,
  );
  // `mutate` is stable across renders. The result object is not, and it
  // would reach every list row as a new callback.
  const { mutate: stage } = useSetStaged();
  const commit = useCommitChanges();
  const { mutate: discardPaths, isPending: discarding } = useDiscardChanges();
  const { mutate: restore, isPending: restoring } = useRestoreDiscard();
  const undo = useUndoCommits(worktree);
  const stash = useStashChanges();
  const resolve = useResolveConflict();
  const [draft, setDraft] = useCommitDraft(projectId, worktreeId);

  // The last commit is only up for rewriting while no remote has it. A
  // requested amend only takes effect while that holds (a push from
  // another window ends it).
  const lastCommit = worktree.recentCommits[0];
  const rewrite = useCommitRewrites(worktree, worktree.recentCommits)(0);
  const amending = amendRequested && rewrite.canAmend;
  const busy =
    commit.isPending ||
    discarding ||
    restoring ||
    undo.pending ||
    stash.isPending ||
    resolve.isPending ||
    stagingHunks ||
    discardingHunks;
  const resetAmendDraft = useAmendDraft({
    projectId,
    worktreeId,
    amending,
    hash: lastCommit?.hash,
    draft,
    setDraft,
  });

  const say = useWorktreeSuccessToast();

  const onCommit = () => {
    const list = files ?? [];
    const included = includedFiles(list).length;
    const wasAmend = amending;
    commit.mutate(
      {
        projectId,
        worktreeId,
        summary: draft.summary.trim(),
        description: draft.description,
        stagePaths: included === 0 ? list.flatMap(changedFilePaths) : undefined,
        amend: wasAmend,
      },
      {
        onSuccess: () => {
          resetAmendDraft();
          setDraft(EMPTY_DRAFT);
          if (wasAmend) setAmending(false);
        },
      },
    );
  };

  const onDiscard = (paths: string[]) => {
    const count = paths.length;
    discardPaths(
      { projectId, worktreeId, paths },
      {
        onSuccess: ({ snapshot }) => {
          toast(`Discarded ${pluralize(count, "file")}`, {
            description: "The contents were snapshotted first.",
            duration: UNDO_TOAST_MS,
            action: {
              label: "Undo",
              onClick: () =>
                restore(
                  { projectId, worktreeId, snapshot },
                  { onSuccess: () => say(worktree, "Changes restored") },
                ),
            },
          });
        },
      },
    );
  };

  // The sidebar's count stands in until the page's own status arrives.
  // A failed first read is not a read still coming: it says so (the
  // query's toast has the details) instead of spinning on.
  const failed = files === undefined && statusError !== null;
  const loading = files === undefined && !failed;
  const changedCount = files ? files.length : worktree.changedCount;
  const list = files ?? [];
  // The message box only has a job with something to commit, or a
  // commit to amend. A clean tree keeps the branch bar and the last
  // commit, which is where the next move (push, amend, undo) lives.
  const showComposer =
    canCommand && (loading || list.length > 0 || amending) && !failed;
  // With nothing to commit, ⌘↵ sends the commits instead: the push (or
  // the publish) the branch bar offers.
  const sendShortcut = usePushShortcut(
    worktree,
    canCommand && !showComposer && !failed && list.length === 0,
  );

  const controls: DiffChangesControls = {
    files: list,
    loading,
    failed,
    busy,
    readOnly: !canCommand,
    selectedKey: picked ? changeKey(picked) : null,
    onSelect: setPickedKey,
    onSetStaged: (paths, staged) =>
      stage({ projectId, worktreeId, paths, staged }),
    onDiscard,
    hunks:
      hunkPath && hunkStates
        ? {
            states: hunkStates,
            onSetStaged: (changes, staged) =>
              stageHunks({
                projectId,
                worktreeId,
                path: hunkPath,
                changes,
                staged,
              }),
            onDiscard: (changes) =>
              discardHunks(
                { projectId, worktreeId, path: hunkPath, changes },
                {
                  onSuccess: ({ snapshot }) =>
                    toast("Discarded the change", {
                      description: "The file was snapshotted first.",
                      duration: UNDO_TOAST_MS,
                      action: {
                        label: "Undo",
                        onClick: () =>
                          restore(
                            { projectId, worktreeId, snapshot },
                            {
                              onSuccess: () => say(worktree, "Change restored"),
                            },
                          ),
                      },
                    }),
                },
              ),
          }
        : undefined,
    onResolve: (path, side) =>
      resolve.mutate({ projectId, worktreeId, path, side }),
    onStash: () => {
      const count = list.length;
      stash.mutate(
        { projectId, worktreeId },
        {
          onSuccess: () => say(worktree, `Stashed ${pluralize(count, "file")}`),
        },
      );
    },
  };

  const footer = (
    <ChangesFooterView
      branchBar={<BranchBar worktree={worktree} />}
      lastCommit={
        lastCommit &&
        rewrite.canAmend && (
          <LastCommitStripView
            commit={lastCommit}
            amending={amending}
            canUndo={rewrite.undo !== null}
            busy={busy}
            onAmend={() => setAmending(true)}
            onUndo={() => {
              const u = rewrite.undo;
              if (u) undo.undoTo(u);
            }}
          />
        )
      }
      composer={
        showComposer && (
          <CommitComposerView
            files={list}
            draft={draft}
            onDraftChange={setDraft}
            pending={commit.isPending}
            error={commit.error}
            amend={
              amending && lastCommit
                ? {
                    hash: lastCommit.hash,
                    onCancel: () => setAmending(false),
                  }
                : null
            }
            onCommit={onCommit}
          />
        )
      }
      readOnlyNote={canCommand ? null : peerReadOnlyNote()}
    />
  );

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
        failed ? (
          "Couldn't read the changes."
        ) : (
          <CleanTreeMessageView
            owed={worktreeSyncView(worktree).owed}
            shortcut={sendShortcut}
          />
        )
      }
      changes={controls}
      sidebarActions={<MergeButton worktree={worktree} />}
      renderSidebar={(fileList) => (
        <GitPageSidebar worktree={worktree} tab="changes" changes={fileList} />
      )}
      footer={footer}
    />
  );
}

// ⌘↵ (or Ctrl+↵) on a page with nothing to commit: run the branch's
// send, a push or a publish, the move the commit box's chord leads to
// anyway. Only those two: they send commits and touch nothing here.
// Answers with what the chord runs ("Push"), or null while it runs
// nothing.
function usePushShortcut(worktree: Worktree, enabled: boolean): string | null {
  const mutations = useSyncMoveMutations();
  const move = worktreeSyncView(worktree).move;
  const send =
    enabled &&
    move &&
    (move.key === "push" || move.key === "publish") &&
    move.disabledReason === undefined
      ? move
      : null;
  const mutation = send ? mutations[send.key] : null;
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  useEffect(() => {
    if (!mutation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      if (e.isComposing || e.defaultPrevented || mutation.isPending) return;
      // A dialog or menu open over the page keeps ⌘↵ for itself.
      if (isOverlayOpen()) return;
      e.preventDefault();
      mutation.mutate(scope);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return send && (send.key === "push" ? "to push" : "to publish");
}
