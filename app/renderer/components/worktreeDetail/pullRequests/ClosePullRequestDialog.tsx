import { useState } from "react";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { ClosePullRequestDialogView } from "@shigomori/ui/views/worktreeDetail/pullRequests/ClosePullRequestDialogView.tsx";
import type { PullRequestDetail, Worktree } from "@shigomori/contracts/schemas";
import { useClosePullRequest } from "@/hooks/pullRequests/useClosePullRequest";

export function ClosePullRequestDialog({
  worktree,
  pr,
  onClose,
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
  onClose: () => void;
}) {
  const close = useClosePullRequest();
  const [comment, setComment] = useState("");
  const busy = close.isPending;
  // Held open while it runs: closed, its failure would go unsaid.
  const dismiss = () => {
    if (!busy) onClose();
  };

  return (
    <ModalShell
      label="Close pull request"
      onClose={dismiss}
      popoverClassName="max-w-2xl"
    >
      <ClosePullRequestDialogView
        pr={pr}
        comment={comment}
        error={close.error?.message}
        busy={busy}
        onComment={setComment}
        onConfirm={() =>
          close.mutate(
            {
              projectId: worktree.projectId,
              branch: worktree.branch,
              number: pr.number,
              comment,
            },
            { onSuccess: onClose },
          )
        }
        onCancel={onClose}
        onClose={dismiss}
      />
    </ModalShell>
  );
}
