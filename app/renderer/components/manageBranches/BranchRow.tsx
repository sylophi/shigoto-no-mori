import { useState } from "react";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
import { useDeleteBranch, useRenameAnyBranch } from "@/hooks/git/useBranches";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { isBranchNotMergedError } from "@shigomori/contracts/errors";
import type { Worktree } from "@shigomori/contracts/schemas";
import {
  BranchDeleteDialogView,
  BranchRowView,
} from "@shigomori/ui/views/manageBranches/BranchRowView.tsx";

export function BranchRow({
  projectId,
  name,
  worktree,
}: {
  projectId: string;
  name: string;
  worktree: Worktree | undefined;
}) {
  // Scope-aware: a peer's checked-out branch opens its worktree under
  // that device's route.
  const { toWorktree } = useWorktreeNav();
  const rename = useRenameAnyBranch();
  const del = useDeleteBranch();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // null when not editing; otherwise holds the in-flight edit value.
  // Folding "editing" and "draft" together avoids initializing local
  // state from the `name` prop.
  const [draft, setDraft] = useState<string | null>(null);

  // A safe delete refused for unmerged commits swaps the modal into its
  // force-delete stage until it closes (sticky, so a transient force
  // failure doesn't drop back to the safe stage). Any other failure
  // keeps a plain retry. Close is ignored while a delete is in flight.
  // The mutation's toast is silenced in favor of the inline banner, so
  // dismissing mid-delete would swallow the failure entirely.
  const [needsForce, setNeedsForce] = useState(false);
  const closeDelete = () => {
    if (del.isPending) return;
    setConfirmingDelete(false);
    setNeedsForce(false);
    del.reset();
  };

  const commitRename = () => {
    const next = (draft ?? "").trim();
    if (!next || next === name) {
      setDraft(null);
      return;
    }
    rename.mutate(
      { projectId, oldName: name, newName: next },
      {
        onSuccess: () => setDraft(null),
        onError: () => setDraft(null),
      },
    );
  };

  return (
    <BranchRowView
      name={name}
      worktree={worktree}
      kindIcon={worktree && <WorktreeKindIcon worktree={worktree} />}
      draft={draft}
      onDraft={setDraft}
      renamePending={rename.isPending}
      onCommitRename={commitRename}
      onOpenWorktree={() => worktree && toWorktree(projectId, worktree.id)}
      onDelete={() => setConfirmingDelete(true)}
      deletePending={del.isPending}
      deleteDialog={
        confirmingDelete && (
          <ModalShell
            label="Delete branch"
            onClose={closeDelete}
            popoverClassName="max-w-md"
          >
            <BranchDeleteDialogView
              name={name}
              needsForce={needsForce}
              error={
                del.isError
                  ? {
                      notMerged: isBranchNotMergedError(del.error),
                      message: del.error.message,
                    }
                  : null
              }
              pending={del.isPending}
              onCancel={closeDelete}
              onDelete={() =>
                del.mutate(
                  { projectId, name, force: needsForce },
                  {
                    onSuccess: closeDelete,
                    onError: (err) => {
                      if (isBranchNotMergedError(err)) setNeedsForce(true);
                    },
                  },
                )
              }
            />
          </ModalShell>
        )
      }
    />
  );
}
