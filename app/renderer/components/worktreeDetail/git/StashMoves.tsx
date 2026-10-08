import { ArchiveRestore, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useApplyStash,
  useDropStash,
  useRestoreStash,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import type { StashEntry, Worktree } from "@shared/schemas";

// Under a stash's title on the Stashes tab: put it back (and drop it,
// or keep it), or drop it. A restore lands on the changes it went back
// into. A drop moves on to the next stash, or to the changes once none
// is left.
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
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  const busy = apply.isPending || drop.isPending;
  const toChanges = () =>
    nav.toDiff(worktree.projectId, worktree.id, { replace: true });
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <Button
        variant="outline"
        size="xs"
        disabled={busy}
        onClick={() =>
          apply.mutate(
            { ...scope, hash: stash.hash, drop: true },
            { onSuccess: toChanges },
          )
        }
      >
        <ArchiveRestore />
        Restore
      </Button>
      <Button
        variant="outline"
        size="xs"
        disabled={busy}
        onClick={() =>
          apply.mutate(
            { ...scope, hash: stash.hash, drop: false },
            { onSuccess: toChanges },
          )
        }
      >
        <ArchiveRestore />
        Restore and keep it
      </Button>
      <Button
        variant="outline-destructive"
        size="xs"
        disabled={busy}
        onClick={() =>
          drop.mutate(
            { ...scope, hash: stash.hash },
            {
              onSuccess: () => {
                if (next) {
                  nav.toStash(worktree.projectId, worktree.id, next, true);
                } else {
                  toChanges();
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
      >
        <Trash2 />
        Drop
      </Button>
    </div>
  );
}
