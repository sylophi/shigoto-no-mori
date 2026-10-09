import {
  useApplyStash,
  useDropStash,
  useRestoreStash,
} from "@/hooks/worktrees/useGitHistory";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import type { StashEntry, Worktree } from "@shigomori/contracts/schemas";
import { StashMovesView } from "./StashMovesView";

// A stash's moves (StashMovesView): restore, keep or drop it.
export function StashMoves({
  worktree,
  stash,
  next,
}: {
  worktree: Worktree;
  stash: StashEntry;
  // The stash to show once this one is dropped.
  next: string | undefined;
}) {
  const nav = useWorktreeNav();
  const apply = useApplyStash();
  const drop = useDropStash();
  const restore = useRestoreStash();
  const { canCommand } = useCommandAccess();
  if (!canCommand) return null;
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  const busy = apply.isPending || drop.isPending;
  const toChanges = () =>
    nav.toDiff(worktree.projectId, worktree.id, { replace: true });
  return (
    <StashMovesView
      busy={busy}
      onRestore={() =>
        apply.mutate(
          { ...scope, hash: stash.hash, drop: true },
          { onSuccess: toChanges },
        )
      }
      onRestoreAndKeep={() =>
        apply.mutate(
          { ...scope, hash: stash.hash, drop: false },
          { onSuccess: toChanges },
        )
      }
      onDrop={() =>
        drop.mutate(
          { ...scope, hash: stash.hash },
          {
            onSuccess: () => {
              if (next) {
                nav.toStash(worktree.projectId, worktree.id, next, true);
              } else {
                nav.toStashes(worktree.projectId, worktree.id, true);
              }
              toast("Dropped the stash", {
                duration: UNDO_TOAST_MS,
                action: {
                  label: "Undo",
                  onClick: () =>
                    restore.mutate({
                      ...scope,
                      hash: stash.hash,
                      message: stash.message,
                      named: stash.named,
                    }),
                },
              });
            },
          },
        )
      }
    />
  );
}
