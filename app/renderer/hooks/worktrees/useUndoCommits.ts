import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import { useResetSoft } from "@/hooks/worktrees/useWorktreeChanges";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { pluralize } from "@shigomori/ui/lib/pluralize.ts";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import type { CommitRewrite } from "@/lib/commitRewrite";
import type { Worktree } from "@shigomori/contracts/schemas";

// Undo commits, as one action for every surface that offers it (the
// changes page's last-commit strip, a commit row's context menu): soft
// reset to `target` (a merge on top is dropped whole), then a toast
// whose Redo puts HEAD back. The backend refuses the redo if anything
// was committed in between. The page follows the changes, since the
// commit it may have shown is gone: to the Changes tab where they are
// staged, or for a merge to the commit the branch is back on.
export function useUndoCommits(worktree: Worktree) {
  const { mutate: reset, isPending } = useResetSoft();
  const say = useWorktreeSuccessToast();
  const nav = useWorktreeNav();
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
          if (merge) nav.toCommit(projectId, worktreeId, target, true);
          else nav.toDiff(projectId, worktreeId, { replace: true });
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
