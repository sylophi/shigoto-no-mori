import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModalShell } from "@/components/ui/modal-shell";
import { Textarea } from "@/components/ui/textarea";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import {
  useCherryPick,
  useRevertCommit,
  useWorktreeOperation,
  useRewordCommit,
  useSquashCommit,
} from "@/hooks/worktrees/useGitHistory";
import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import { useUndoCommits } from "@/hooks/worktrees/useUndoCommits";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { commitMessageQueryOptions } from "@/hooks/worktrees/useWorktreeChanges";
import type { CommitSummary, Worktree } from "@shared/schemas";

// Everything a commit's menu or buttons can do, as one object per
// surface (the Git timeline, a commit's page) rather than a
// subscription per row. `dialog` is the reword dialog, rendered by the
// surface. `onRewritten` hears a reword or squash land, after which the
// commits from there up have new hashes. On a peer that takes no
// commands from here, nothing is offered (`canCommand` for the moves
// with no flag of their own), and only copying is left.
export function useCommitActions(
  worktree: Worktree,
  onRewritten?: (worktree: Worktree) => void,
) {
  const { projectId, id: worktreeId } = worktree;
  const undo = useUndoCommits(worktree);
  const revert = useRevertCommit();
  const cherryPick = useCherryPick();
  const squash = useSquashCommit();
  const { quickCreate, isPending: creating } = useQuickCreateWorktree();
  const say = useWorktreeSuccessToast();
  const { data: siblings } = useWorktrees(projectId);
  const { data: operation } = useWorktreeOperation(worktree);
  const { canCommand } = useCommandAccess();
  const [rewording, setRewording] = useState<{
    hash: string;
    head: string;
  } | null>(null);

  return {
    canCommand,
    undoTo: undo.undoTo,
    // A revert is a commit of its own, which waits while a merge,
    // rebase or squash does.
    canRevert: canCommand && operation?.operation == null,
    // The worktrees a commit can be cherry-picked onto: the project's
    // others on this device that hold a branch.
    pickTargets: canCommand
      ? (siblings ?? []).filter(
          (other) => other.id !== worktreeId && !other.detached,
        )
      : [],
    pending:
      undo.pending ||
      revert.isPending ||
      cherryPick.isPending ||
      squash.isPending ||
      creating,
    revert: (commit: CommitSummary) =>
      revert.mutate({ projectId, worktreeId, hash: commit.hash }),
    cherryPickInto: (target: Worktree, commit: CommitSummary) =>
      cherryPick.mutate(
        { projectId, worktreeId: target.id, hash: commit.hash },
        {
          onSuccess: (landed) =>
            say(landed, `Cherry-picked ${commit.hash} onto ${landed.branch}`),
        },
      ),
    newWorktreeFrom: (commit: CommitSummary) =>
      void quickCreate(projectId, undefined, commit.hash),
    squash: (commit: CommitSummary, head: string) =>
      squash.mutate(
        { projectId, worktreeId, hash: commit.hash, expectHead: head },
        { onSuccess: (rewritten) => onRewritten?.(rewritten) },
      ),
    reword: (commit: CommitSummary, head: string) =>
      setRewording({ hash: commit.hash, head }),
    dialog: rewording && (
      <RewordDialog
        worktree={worktree}
        hash={rewording.hash}
        head={rewording.head}
        onClose={() => setRewording(null)}
        onRewritten={onRewritten}
      />
    ),
  };
}

export type CommitActions = ReturnType<typeof useCommitActions>;

function RewordDialog({
  worktree,
  hash,
  head,
  onClose,
  onRewritten,
}: {
  worktree: Worktree;
  hash: string;
  head: string;
  onClose: () => void;
  onRewritten: ((worktree: Worktree) => void) | undefined;
}) {
  const scope = useHostScope();
  const message = useQuery(
    commitMessageQueryOptions(scope, worktree.projectId, worktree.id, hash),
  );
  return (
    <ModalShell onClose={onClose} popoverClassName="max-w-lg">
      <div className="p-5">
        <h2 className="text-base font-semibold">
          Reword <span className="font-mono">{hash}</span>
        </h2>
        {message.data ? (
          <RewordForm
            worktree={worktree}
            hash={hash}
            head={head}
            initial={message.data}
            onClose={onClose}
            onRewritten={onRewritten}
          />
        ) : (
          <div className="mt-4 h-40" />
        )}
      </div>
    </ModalShell>
  );
}

function RewordForm({
  worktree,
  hash,
  head,
  initial,
  onClose,
  onRewritten,
}: {
  worktree: Worktree;
  hash: string;
  head: string;
  initial: { summary: string; description: string };
  onClose: () => void;
  onRewritten: ((worktree: Worktree) => void) | undefined;
}) {
  const [summary, setSummary] = useState(initial.summary);
  const [description, setDescription] = useState(initial.description);
  const reword = useRewordCommit();
  const canSave = summary.trim().length > 0 && !reword.isPending;
  const save = () => {
    if (!canSave) return;
    reword.mutate(
      {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        hash,
        summary,
        description,
        expectHead: head,
      },
      {
        onSuccess: (rewritten) => {
          onClose();
          onRewritten?.(rewritten);
        },
      },
    );
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  };
  return (
    <div className="mt-4 flex flex-col gap-2">
      <Input
        aria-label="Summary"
        placeholder="Summary (required)"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={onKeyDown}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to edit this field
        autoFocus
      />
      <Textarea
        aria-label="Description"
        placeholder="Description"
        rows={5}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={!canSave}>
          Reword
        </Button>
      </div>
    </div>
  );
}
