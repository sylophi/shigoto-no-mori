import { useState } from "react";
import { GitMerge } from "lucide-react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { BranchCombobox } from "@/components/shared/BranchCombobox";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import {
  useMergeBranch,
  useMergePreview,
  useWorktreeOperation,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { IntegrateMethod, Worktree } from "@shigomori/contracts/schemas";
import { MergeDialogView } from "@shigomori/ui/views/worktreeDetail/git/MergeDialogView.tsx";

// The Git page's way to bring another branch in, opening the dialog.
// None on a peer that takes no commands from here.
export function MergeButton({ worktree }: { worktree: Worktree }) {
  const [open, setOpen] = useState(false);
  const { canCommand } = useCommandAccess();
  if (!canCommand) return null;
  return (
    <>
      <Button variant="ghost" size="xs" onClick={() => setOpen(true)}>
        <GitMerge />
        Merge
      </Button>
      {open && (
        <MergeDialog worktree={worktree} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

// The merge dialog (MergeDialogView): the preview of the move, and the
// move.
function MergeDialog({
  worktree,
  onClose,
}: {
  worktree: Worktree;
  onClose: () => void;
}) {
  const nav = useWorktreeNav();
  const say = useWorktreeSuccessToast();
  const { projectId, id: worktreeId, branch } = worktree;
  const [ref, setRef] = useState(
    worktree.primaryRef !== undefined && !worktree.isPrimary
      ? worktree.primaryRef
      : "",
  );
  const [picked, setPicked] = useState<IntegrateMethod | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const preview = useMergePreview(worktree, ref);
  const { data: operation } = useWorktreeOperation(worktree);
  const merge = useMergeBranch();
  const data = preview.data;
  // Until one is picked: a fast-forward where the branch has nothing of
  // its own, a merge otherwise.
  const method = picked ?? (data?.own === 0 ? "fastForward" : "merge");
  const squashMessage = message ?? data?.incomingSubject ?? "";
  const blocked =
    operation?.operation != null
      ? `Finish or abort the ${operation.operation} first.`
      : worktree.changedCount > 0
        ? "Commit or stash your changes first."
        : null;
  const ready =
    data !== undefined &&
    data.incoming > 0 &&
    !(method === "fastForward" && data.own > 0) &&
    !(method === "squash" && squashMessage.trim() === "") &&
    blocked === null &&
    !merge.isPending;

  const submit = () => {
    if (!ready) return;
    merge.mutate(
      {
        projectId,
        worktreeId,
        ref,
        method,
        message: method === "squash" ? squashMessage.trim() : undefined,
      },
      {
        onSuccess: ({ worktree: after, stopped }) => {
          onClose();
          if (stopped) {
            nav.toDiff(projectId, worktreeId, { replace: true });
            return;
          }
          say(after, DONE[method](ref));
          const head = after.recentCommits[0]?.hash;
          if (head) nav.toCommit(projectId, worktreeId, head, true);
        },
      },
    );
  };

  return (
    // Held open while the move runs: closed, its stop or its failure
    // would go unsaid.
    <ModalShell
      label={`Merge into ${branch}`}
      onClose={() => {
        if (!merge.isPending) onClose();
      }}
      popoverClassName="max-w-md"
    >
      <MergeDialogView
        branch={branch}
        source={ref}
        from={
          <BranchCombobox
            id="merge-from"
            projectId={projectId}
            value={ref}
            onChange={(next) => {
              setRef(next);
              setMessage(null);
              merge.reset();
            }}
            excludeBranches={[branch]}
            pinnedBranch={worktree.primaryRef}
          />
        }
        method={method}
        onMethod={(next) => {
          setPicked(next);
          merge.reset();
        }}
        preview={data}
        previewError={preview.error}
        squashMessage={squashMessage}
        onSquashMessage={setMessage}
        mergeError={merge.error?.message}
        blocked={blocked}
        pending={merge.isPending}
        ready={ready}
        onSubmit={submit}
        onCancel={onClose}
      />
    </ModalShell>
  );
}

const DONE: Record<IntegrateMethod, (ref: string) => string> = {
  merge: (ref) => `Merged ${ref}`,
  squash: (ref) => `Squashed ${ref} into one commit`,
  rebase: (ref) => `Rebased onto ${ref}`,
  fastForward: (ref) => `Fast-forwarded to ${ref}`,
};
