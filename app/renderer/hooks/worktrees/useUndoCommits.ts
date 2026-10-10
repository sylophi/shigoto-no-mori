import { useQueryClient } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  commitMessageQueryOptions,
  useResetSoft,
} from "@/hooks/worktrees/useWorktreeChanges";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { fillEmptyCommitDraft } from "@/lib/commitDraft";
import { pluralize } from "@/lib/pluralize";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import type { CommitRewrite } from "@/lib/commitRewrite";
import type { Worktree } from "@shared/schemas";

// Undo commits, as one action for every surface that offers it (the
// changes page's last-commit strip, a commit row's context menu): soft
// reset to `target` (a merge on top is dropped whole). The page follows
// the changes, since the commit it may have shown is gone: to the
// Changes tab where they are staged, or for a merge to the commit the
// branch is back on.
//
// Undoing one commit puts its message back in an empty commit box, as
// GitHub Desktop does, and committing again is the redo. Several
// commits or a merge can't be made again from the box, so those get a
// toast whose Redo puts HEAD back. The backend refuses the redo if
// anything was committed in between.
export function useUndoCommits(worktree: Worktree) {
  const { mutate: reset, isPending } = useResetSoft();
  const queryClient = useQueryClient();
  const scope = useHostScope();
  const nav = useWorktreeNav();
  const { projectId, id: worktreeId } = worktree;

  // A failed read has the query's own toast.
  const restoreMessage = (hash: string) =>
    void queryClient
      .fetchQuery(commitMessageQueryOptions(scope, projectId, worktreeId, hash))
      .then(
        (message) => fillEmptyCommitDraft(projectId, worktreeId, message),
        () => {},
      );

  const undoTo = ({
    target,
    count,
    head,
    merge,
  }: NonNullable<CommitRewrite["undo"]>) => {
    reset(
      { projectId, worktreeId, target, expectHead: head },
      {
        onSuccess: ({ previousHead }) => {
          if (merge) nav.toCommit(projectId, worktreeId, target, true);
          else nav.toDiff(projectId, worktreeId, { replace: true });
          if (!merge && count === 1) {
            restoreMessage(previousHead);
            return;
          }
          toast(
            merge ? "Undid the merge" : `Undid ${pluralize(count, "commit")}`,
            {
              description: merge
                ? "The branch is back as it was before it."
                : "The changes are back in the working tree, staged.",
              duration: UNDO_TOAST_MS,
              action: {
                label: "Redo",
                onClick: () =>
                  reset({
                    projectId,
                    worktreeId,
                    target: previousHead,
                    expectHead: target,
                  }),
              },
            },
          );
        },
      },
    );
  };

  return { undoTo, pending: isPending };
}
