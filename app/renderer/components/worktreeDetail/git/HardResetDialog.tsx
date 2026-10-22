import { useState } from "react";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { HardResetDialogView } from "@shigomori/ui/views/worktreeDetail/git/HardResetDialogView.tsx";
import { BranchCombobox } from "@/components/shared/BranchCombobox";
import {
  useMergePreview,
  useResetHard,
  useUndoResetHard,
  useWorktreeOperation,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import type { Worktree } from "@shigomori/contracts/schemas";

// The hard reset dialog (HardResetDialogView): where the branch would
// go, and the move, with an Undo on its toast. The History tab opens on
// where the branch landed. `initialRef` is the commit a commit's menu
// opened it on.
export function HardResetDialog({
  worktree,
  initialRef = "",
  onClose,
}: {
  worktree: Worktree;
  initialRef?: string;
  onClose: () => void;
}) {
  const nav = useWorktreeNav();
  const { projectId, id: worktreeId, branch } = worktree;
  const [ref, setRef] = useState(initialRef);
  const preview = useMergePreview(worktree, ref, true);
  const { data: operation } = useWorktreeOperation(worktree);
  const reset = useResetHard();
  const undo = useUndoResetHard();
  const data = preview.data;
  const dirty = worktree.changedCount !== 0;
  const blocked =
    operation?.operation != null
      ? `Finish or abort the ${operation.operation} first.`
      : null;
  const ready =
    data !== undefined &&
    (data.incoming > 0 || data.own > 0 || dirty) &&
    blocked === null &&
    !reset.isPending;

  const submit = () => {
    if (!ready) return;
    // Pinned to the HEAD the preview counted from.
    const expectHead = worktree.recentCommits[0]?.hash;
    reset.mutate(
      { projectId, worktreeId, ref, expectHead },
      {
        onSuccess: ({ previousHead, head, snapshot, worktree: after }) => {
          onClose();
          // The page's own hash for it, which the History list marks.
          nav.toCommit(
            projectId,
            worktreeId,
            after.recentCommits[0]?.hash ?? head,
            true,
          );
          toast(`Hard reset ${branch} to ${ref}`, {
            duration: UNDO_TOAST_MS,
            action: {
              label: "Undo",
              onClick: () =>
                undo.mutate({
                  projectId,
                  worktreeId,
                  previousHead,
                  at: head,
                  snapshot,
                }),
            },
          });
        },
      },
    );
  };

  return (
    // Held open while the reset runs: closed, its failure would go
    // unsaid.
    <ModalShell
      label={`Hard reset ${branch}`}
      onClose={() => {
        if (!reset.isPending) onClose();
      }}
      popoverClassName="max-w-md"
    >
      <HardResetDialogView
        branch={branch}
        target={ref}
        to={
          <BranchCombobox
            id="reset-to"
            projectId={projectId}
            value={ref}
            onChange={(next) => {
              setRef(next);
              reset.reset();
            }}
            placeholder="Select a branch or commit…"
            excludeBranches={[branch]}
            pinnedBranch={worktree.primaryRef}
          />
        }
        dirty={dirty}
        preview={data}
        previewError={preview.error}
        resetError={reset.error?.message}
        blocked={blocked}
        pending={reset.isPending}
        ready={ready}
        onSubmit={submit}
        onCancel={onClose}
      />
    </ModalShell>
  );
}
