import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { useSearch } from "@tanstack/react-router";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
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
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import { commitRewriteAt } from "@/lib/commitRewrite";
import { worktreeSyncView } from "@/lib/syncState";
import { changeKey, isUntracked, type Worktree } from "@shared/schemas";
import { changedFilePaths, includedFiles } from "./changesControls";
import { BranchBar } from "./BranchBar";
import { CommitComposer } from "./CommitComposer";
import { DiffView } from "./DiffView";
import { LastCommitStrip } from "./LastCommitStrip";
import { WorktreeMissing } from "@/components/shared/WorktreeMissing";

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
    return <WorktreeMissing {...missing} />;
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

// The uncommitted-changes page: the diff, with the file list turned into a
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
  const nav = useWorktreeNav();
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
  const { data: hunkStates } = useFileHunks(projectId, worktreeId, hunkPath);
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
  const rewrite = commitRewriteAt(worktree, worktree.recentCommits, 0);
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
          say(
            worktree,
            wasAmend ? `Amended into ${hash}` : `Committed ${hash}`,
            {
              description: `${pluralize(count, "file")} to ${worktree.branch}`,
              action: {
                label: "View",
                onClick: () => nav.toCommit(projectId, worktreeId, hash),
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
  const showComposer = (loading || list.length > 0 || amending) && !failed;

  return (
    <DiffView
      diff={diff}
      onBack={onBack}
      worktree={worktree}
      title="Uncommitted changes"
      subtitle={
        <>
          {changedCount > 0
            ? `${pluralize(changedCount, "file")} changed`
            : "No changes"}{" "}
          in <span className="font-mono">{worktree.name}</span>
        </>
      }
      emptyMessage={
        failed ? (
          "Couldn't read the changes."
        ) : (
          <CleanTreeMessage worktree={worktree} />
        )
      }
      changes={{
        files: list,
        loading,
        failed,
        busy,
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
                                  onSuccess: () =>
                                    say(worktree, "Change restored"),
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
              onSuccess: () =>
                say(worktree, `Stashed ${pluralize(count, "file")}`),
            },
          );
        },
      }}
      footer={
        <div
          data-slot="changes-footer"
          className={cn(
            "flex flex-col border-t border-border",
            !showComposer && "pb-1.5",
          )}
        >
          <BranchBar worktree={worktree} />
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
          {showComposer && (
            <CommitComposer
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
          )}
        </div>
      }
    />
  );
}

// What the pane says once everything is committed: that the tree is
// clean, and what the branch still owes the remote, the next thing to
// do, which the branch bar below has the button for.
function CleanTreeMessage({ worktree }: { worktree: Worktree }) {
  const next = worktreeSyncView(worktree).owed;
  return (
    <span className="flex flex-col items-center gap-2">
      <CircleCheck aria-hidden className="size-6 text-muted-foreground/60" />
      <span className="text-foreground">No uncommitted changes</span>
      {next && <span className="text-xs">{next}</span>}
    </span>
  );
}
