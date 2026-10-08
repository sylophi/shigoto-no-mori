import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import { useResetSoft } from "@/hooks/worktrees/useWorktreeChanges";
import { pluralize } from "@/lib/pluralize";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import type { CommitRewrite } from "@/lib/commitRewrite";
import type { Worktree } from "@shared/schemas";

// Undo commits, as one action for every surface that offers it (the
// changes page's last-commit strip, a commit row's context menu): soft
// reset to `target` (a merge on top is dropped whole), then a toast
// whose Redo puts HEAD back. The
// backend refuses the redo if anything was committed in between.
export function useUndoCommits(worktree: Worktree) {
  const { mutate: reset, isPending } = useResetSoft();
  const say = useWorktreeSuccessToast();
  const { projectId, id: worktreeId } = worktree;

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
                  reset(
                    {
                      projectId,
                      worktreeId,
                      target: previousHead,
                      expectHead: target,
                    },
                    {
                      onSuccess: () =>
                        say(
                          worktree,
                          merge
                            ? "Restored the merge"
                            : `Restored ${pluralize(count, "commit")}`,
                        ),
                    },
                  ),
              },
            },
          );
        },
      },
    );
  };

  return { undoTo, pending: isPending };
}
