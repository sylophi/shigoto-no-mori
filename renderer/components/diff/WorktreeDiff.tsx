import { useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useFileDiff } from "@/hooks/worktrees/useWorktreeDiff";
import {
  useCommitChanges,
  useDiscardChanges,
  useRestoreDiscard,
  useSetStaged,
  useWorktreeChanges,
} from "@/hooks/worktrees/useWorktreeChanges";
import { useAmendDraft } from "@/hooks/worktrees/useAmendDraft";
import { useUndoCommits } from "@/hooks/worktrees/useUndoCommits";
import { EMPTY_DRAFT, useCommitDraft } from "@/lib/commitDraft";
import { pluralize } from "@/lib/pluralize";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import { commitRewriteAt } from "@/lib/commitRewrite";
import { changeKey, isUntracked, type Worktree } from "@shared/schemas";
import { changedFilePaths, includedFiles } from "./changesControls";
import { CommitComposer } from "./CommitComposer";
import { DiffView } from "./DiffView";
import { LastCommitStrip } from "./LastCommitStrip";
import { WorktreeMissing } from "./WorktreeMissing";

const route = getRouteApi("/projects/$projectId/worktrees/$worktreeId/diff");

export function WorktreeDiff() {
  const { projectId, worktreeId } = route.useParams();
  const { amend } = route.useSearch();
  const navigate = useNavigate();
  const {
    data: worktrees = [],
    isPending,
    isError,
    refetch,
  } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);

  const goBack = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId",
      params: { projectId, worktreeId },
    });

  // Amend mode lives in the route's search param, so the page and the
  // row menu that opens it agree on one source of truth.
  const setAmending = (on: boolean) =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId/diff",
      params: { projectId, worktreeId },
      search: on ? { amend: true } : {},
      replace: true,
    });

  if (!worktree) {
    return (
      <WorktreeMissing
        isPending={isPending}
        isError={isError}
        refetch={refetch}
        onBack={goBack}
        message="Worktree not found."
      />
    );
  }

  return (
    <ChangesView
      worktree={worktree}
      onBack={goBack}
      amendRequested={amend === true}
      setAmending={setAmending}
    />
  );
}

// The uncommitted-changes page: the diff, with the rail turned into a
// GitHub-Desktop-style changes list (tick what goes in, discard what
// doesn't) and the commit composer under it. Split from the route
// component so the change hooks only mount once the worktree resolved.
function ChangesView({
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
  const navigate = useNavigate();
  const { projectId, id: worktreeId } = worktree;
  const { data: files } = useWorktreeChanges(projectId, worktreeId);
  // The pick is held as the row's key and resolved against the live
  // list, so a file that stops being changed (discarded, committed,
  // reverted in an editor) falls back to the first row instead of
  // leaving the pane pointing at nothing.
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const picked =
    files?.find((file) => changeKey(file) === pickedKey) ?? files?.[0] ?? null;
  const {
    data: patch,
    isLoading,
    error,
  } = useFileDiff(
    projectId,
    worktreeId,
    picked ? changedFilePaths(picked) : [],
    picked ? isUntracked(picked) : false,
  );
  // `mutate` is stable across renders. The result object is not, and it
  // would reach every rail row as a new callback.
  const { mutate: stage } = useSetStaged();
  const commit = useCommitChanges();
  const { mutate: discardPaths, isPending: discarding } = useDiscardChanges();
  const { mutate: restore, isPending: restoring } = useRestoreDiscard();
  const undo = useUndoCommits(worktree);
  const [draft, setDraft] = useCommitDraft(projectId, worktreeId);

  // The last commit is only up for rewriting while no remote has it. A
  // requested amend only takes effect while that holds (a push from
  // another window ends it).
  const lastCommit = worktree.recentCommits[0];
  const rewrite = commitRewriteAt(worktree, worktree.recentCommits, 0);
  const amending = amendRequested && rewrite.canAmend;
  const busy = commit.isPending || discarding || restoring || undo.pending;
  const resetAmendDraft = useAmendDraft({
    projectId,
    worktreeId,
    amending,
    hash: lastCommit?.hash,
    draft,
    setDraft,
  });

  const onCommit = () => {
    const list = files ?? [];
    const included = includedFiles(list).length;
    // Nothing ticked means all of it (see CommitComposer).
    const count = included > 0 ? included : list.length;
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
        onSuccess: ({ hash }) => {
          resetAmendDraft();
          setDraft(EMPTY_DRAFT);
          if (wasAmend) setAmending(false);
          toast.success(
            wasAmend ? `Amended into ${hash}` : `Committed ${hash}`,
            {
              description: `${pluralize(count, "file")} to ${worktree.branch}`,
              action: {
                label: "View",
                onClick: () =>
                  void navigate({
                    to: "/projects/$projectId/worktrees/$worktreeId/commits/$hash",
                    params: { projectId, worktreeId, hash },
                  }),
              },
            },
          );
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
                  { onSuccess: () => toast.success("Changes restored") },
                ),
            },
          });
        },
      },
    );
  };

  // The sidebar's count stands in until the page's own status arrives.
  const changedCount = files ? files.length : worktree.changedCount;
  const list = files ?? [];

  return (
    <DiffView
      patch={patch}
      isLoading={isLoading}
      error={error}
      onBack={onBack}
      backLabel={worktree.branch}
      title="Uncommitted changes"
      subtitle={
        <>
          {pluralize(changedCount, "file")} changed in{" "}
          <span className="font-mono">{worktree.name}</span>
        </>
      }
      emptyMessage="No uncommitted changes."
      changes={{
        files: list,
        busy,
        selectedKey: picked ? changeKey(picked) : null,
        onSelect: setPickedKey,
        onSetStaged: (paths, staged) =>
          stage({ projectId, worktreeId, paths, staged }),
        onDiscard,
      }}
      railFooter={
        <>
          {lastCommit && rewrite.canAmend && (
            <LastCommitStrip
              commit={lastCommit}
              amending={amending}
              canUndo={rewrite.undo !== null}
              busy={busy}
              onAmend={() => setAmending(true)}
              onUndo={() => {
                const u = rewrite.undo;
                if (u) undo.undoTo(u.target, u.count, u.head);
              }}
            />
          )}
          <CommitComposer
            worktree={worktree}
            files={list}
            draft={draft}
            onDraftChange={setDraft}
            pending={commit.isPending}
            error={commit.error}
            amend={
              amending && lastCommit
                ? { hash: lastCommit.hash, onCancel: () => setAmending(false) }
                : null
            }
            onCommit={onCommit}
          />
        </>
      }
    />
  );
}
