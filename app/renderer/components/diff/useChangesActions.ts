import { useEffect, useState, type ComponentProps } from "react";
import { changesState } from "@/lib/changesState";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useFileDiff } from "@/hooks/worktrees/useWorktreeDiff";
import {
  useCommitChanges,
  useDiscardChanges,
  useDiscardHunks,
  useFileHunks,
  useRestoreDiscard,
  useWorktreeChanges,
} from "@/hooks/worktrees/useWorktreeChanges";
import { useAmendDraft } from "@/hooks/worktrees/useAmendDraft";
import { useWarmGitPages } from "@/hooks/worktrees/useWarmGitPages";
import {
  updatePicks,
  useChangesPicks,
} from "@/hooks/worktrees/useChangesPicks";
import {
  useResolveConflict,
  useStashChanges,
} from "@/hooks/worktrees/useGitHistory";
import { useUndoCommits } from "@/hooks/worktrees/useUndoCommits";
import { EMPTY_DRAFT, useCommitDraft } from "@/lib/commitDraft";
import { pluralize } from "@shigomori/contracts/words";
import { useBinding, useKeymapAction } from "@/hooks/ui/useKeymap";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import { useCommitRewrites } from "@/hooks/worktrees/useCommitRewrites";
import { worktreeSyncView } from "@shigomori/ui/lib/syncState.ts";
import {
  useRunningSyncs,
  useSyncMoveMutations,
} from "@/hooks/worktrees/useWorktreeSync";
import { changeKey, type Worktree } from "@shigomori/contracts/schemas";
import {
  afterCommit,
  commitPicksOf,
  countIncluded,
  pickedHunks,
  prunedPicks,
  setFilesTicked,
  setHunksTicked,
} from "@shigomori/ui/views/diff/changesPicks.ts";
import {
  type DiffChangesControls,
  ticksByHunk,
} from "@shigomori/ui/views/diff/changesControls.ts";
import type { CommitComposerView } from "@shigomori/ui/views/diff/CommitComposerView.tsx";
import type { LastCommitStripView } from "@shigomori/ui/views/diff/LastCommitStripView.tsx";

// What the uncommitted-changes page does: the picks and the file in
// the pane, the commit (and the amend) of what is ticked, and the
// discards, each with an Undo off the snapshot taken first.
export function useChangesActions(
  worktree: Worktree,
  amendRequested: boolean,
  setAmending: (on: boolean) => void,
) {
  const { canCommand } = useCommandAccess();
  const { deviceId } = useHostScope();
  const warm = useWarmGitPages(worktree);
  const { projectId, id: worktreeId } = worktree;
  const { data: files, error: statusError } = useWorktreeChanges(
    projectId,
    worktreeId,
  );
  const { failed, loading, changedCount, list } = changesState(
    files,
    statusError,
    worktree.changedCount,
  );
  const picks = useChangesPicks(deviceId, projectId, worktreeId);
  const setPicks = (change: Parameters<typeof updatePicks>[3]) =>
    updatePicks(deviceId, projectId, worktreeId, change);
  // The pick is held as the row's key and resolved against the live
  // list, so a file that stops being changed (discarded, committed,
  // reverted in an editor) falls back to the first row instead of
  // leaving the pane pointing at nothing.
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  // Off the list shown: a read that failed shows no file, so no diff
  // and no hunk to act on stands from the last read.
  const picked =
    list.find((file) => changeKey(file) === pickedKey) ?? list[0] ?? null;
  const hunkPath = picked && ticksByHunk(picked) ? picked.path : undefined;
  const { data: fileHunks } = useFileHunks(
    projectId,
    worktreeId,
    canCommand ? hunkPath : undefined,
  );
  const paneKey = picked ? changeKey(picked) : null;
  // Each fresh read drops the picks about what is no longer there, so
  // the boxes and the commit agree.
  useEffect(() => {
    if (!files) return;
    const pane =
      paneKey && fileHunks ? { key: paneKey, hunks: fileHunks } : undefined;
    updatePicks(deviceId, projectId, worktreeId, (current) =>
      prunedPicks(current, files, pane),
    );
  }, [deviceId, projectId, worktreeId, files, paneKey, fileHunks]);
  const { mutate: discardHunks, isPending: discardingHunks } =
    useDiscardHunks();
  const diff = useFileDiff(projectId, worktreeId, picked);
  const commit = useCommitChanges();
  const { mutate: discardPaths, isPending: discarding } = useDiscardChanges();
  const { mutate: restore, isPending: restoring } = useRestoreDiscard();
  const undo = useUndoCommits(worktree);
  const stash = useStashChanges();
  const resolve = useResolveConflict();
  const [draft, setDraft] = useCommitDraft(deviceId, projectId, worktreeId);

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
    discardingHunks;
  const resetAmendDraft = useAmendDraft({
    projectId,
    worktreeId,
    amending,
    hash: lastCommit?.hash,
    draft,
    setDraft,
  });

  const onCommit = () => {
    const wasAmend = amending;
    commit.mutate(
      {
        projectId,
        worktreeId,
        summary: draft.summary.trim(),
        description: draft.description,
        ...commitPicksOf(picks, files ?? []),
        amend: wasAmend,
      },
      {
        onSuccess: () => {
          setPicks(afterCommit);
          resetAmendDraft();
          setDraft(EMPTY_DRAFT);
          if (wasAmend) setAmending(false);
        },
      },
    );
  };

  // The ticked files into the last commit, its message kept. The draft
  // is for the next commit, so it stays.
  const onAddToLast = () =>
    commit.mutate(
      {
        projectId,
        worktreeId,
        ...commitPicksOf(picks, files ?? []),
        amend: true,
      },
      { onSuccess: () => setPicks(afterCommit) },
    );

  const discardWithUndo =
    (title: string, description: string) =>
    ({ snapshot }: { snapshot: string }) =>
      toast(title, {
        description,
        duration: UNDO_TOAST_MS,
        action: {
          label: "Undo",
          onClick: () => restore({ projectId, worktreeId, snapshot }),
        },
      });

  // The message box only has a job with something to commit, or a
  // commit to amend. A clean tree keeps the branch bar and the last
  // commit, which is where the next move (push, amend, undo) lives.
  const showComposer =
    canCommand && (loading || list.length > 0 || amending) && !failed;
  // With nothing to commit, the commit keys send the commits instead:
  // the push (or the publish) the branch bar offers.
  const commitKeys = useBinding("commit");
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
    selectedKey: paneKey,
    onSelect: setPickedKey,
    onWarm: warm.file,
    picks,
    onSetTicked: (rows, ticked) =>
      setPicks((current) =>
        setFilesTicked(current, rows.map(changeKey), ticked),
      ),
    onDiscard: (paths) =>
      discardPaths(
        { projectId, worktreeId, paths },
        {
          onSuccess: discardWithUndo(
            `Discarded ${pluralize(paths.length, "file")}`,
            "The contents were snapshotted first.",
          ),
        },
      ),
    hunks:
      hunkPath && paneKey && fileHunks
        ? {
            changes: fileHunks.changes,
            picked: pickedHunks(picks, paneKey, fileHunks),
            onSetTicked: (changes, ticked) =>
              setPicks((current) =>
                setHunksTicked(current, paneKey, fileHunks, changes, ticked),
              ),
            onDiscard: (changes) =>
              discardHunks(
                { projectId, worktreeId, path: hunkPath, changes },
                {
                  onSuccess: discardWithUndo(
                    "Discarded the change",
                    "The file was snapshotted first.",
                  ),
                },
              ),
          }
        : undefined,
    onResolve: (path, side) =>
      resolve.mutate({ projectId, worktreeId, path, side }),
    onStash: () => stash.mutate({ projectId, worktreeId }),
  };

  const lastCommitStrip: ComponentProps<typeof LastCommitStripView> | null =
    lastCommit && rewrite.canAmend
      ? {
          commit: lastCommit,
          amending,
          canUndo: rewrite.undo !== null,
          busy,
          onAmend: () => setAmending(true),
          onUndo: () => {
            const u = rewrite.undo;
            if (u) undo.undoTo(u);
          },
        }
      : null;

  const composer: ComponentProps<typeof CommitComposerView> | null =
    showComposer
      ? {
          files: list,
          included: countIncluded(picks, list),
          draft,
          onDraftChange: setDraft,
          commitKeys,
          pending: commit.isPending,
          error: commit.error,
          amend:
            amending && lastCommit
              ? { hash: lastCommit.hash, onCancel: () => setAmending(false) }
              : null,
          addToLast:
            lastCommit && rewrite.canAmend && !amending
              ? { subject: lastCommit.subject, onAdd: onAddToLast }
              : null,
          onCommit,
        }
      : null;

  return {
    diff,
    changedCount,
    controls,
    sendShortcut,
    lastCommit: lastCommitStrip,
    composer,
  };
}

// The commit keys (⌘↩) on a page with nothing to commit: run the
// branch's send, a push or a publish, the move the commit box's keys
// lead to anyway. Only those two: they send commits and touch nothing
// here. Answers with the keys and what they run ("to push"), and its
// words while it runs, or null while they run nothing.
function usePushShortcut(
  worktree: Worktree,
  enabled: boolean,
): { keys: string; does: string; running?: string } | null {
  const mutations = useSyncMoveMutations();
  const running = useRunningSyncs(worktree);
  const keys = useBinding("commit");
  const move = worktreeSyncView(worktree).move;
  // Another sync on the worktree holds the send until it's done.
  const send =
    enabled &&
    move &&
    (move.key === "push" || move.key === "publish") &&
    move.disabledReason === undefined &&
    running.every((other) => other === move.key)
      ? move
      : null;
  const mutation = send ? mutations[send.key] : null;
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  useKeymapAction(
    "commit",
    () => {
      if (!mutation || running.length > 0) return false;
      mutation.mutate(scope);
    },
    { enabled: mutation !== null },
  );
  if (!send) return null;
  const push = send.key === "push";
  return {
    keys: keys.label,
    does: push ? "to push" : "to publish",
    running: running.includes(send.key)
      ? push
        ? "Pushing…"
        : "Publishing…"
      : undefined,
  };
}
