import { ArchiveRestore, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RelativeDate } from "@/components/ui/relative-date";
import { WorktreeMissing } from "@/components/shared/WorktreeMissing";
import { GitPageSidebar } from "@/components/worktreeDetail/git/GitPageSidebar";
import {
  useApplyStash,
  useDropStash,
  useRestoreStash,
  useWorktreeStashes,
} from "@/hooks/worktrees/useGitHistory";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useStashDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import type { StashEntry, Worktree } from "@shared/schemas";
import { DiffView } from "./DiffView";

// One stash on the Git page: what it holds, and the moves on it. Once
// it is restored or dropped there is nothing left to show, so the page
// moves to the changes it went back into, or back to the worktree.
export function StashDiff() {
  const { projectId, hash, worktree, goBack, missing } = useRouteWorktree();
  const diff = useStashDiff(projectId, worktree?.id, hash);
  const { data: stashes } = useWorktreeStashes(worktree);

  if (!worktree) {
    return <WorktreeMissing {...missing} />;
  }
  const stash = stashes?.find((s) => s.hash === hash);

  return (
    <DiffView
      diff={diff}
      onBack={goBack}
      worktree={worktree}
      title={
        stash ? (stash.named ? stash.message : "Stashed changes") : "Stash"
      }
      subtitle={
        stash && (
          <>
            {!stash.named && `On top of ${stash.message} · `}
            Stashed <RelativeDate date={stash.date} />
          </>
        )
      }
      details={stash && <StashMoves worktree={worktree} stash={stash} />}
      renderSidebar={(files) => (
        <GitPageSidebar
          worktree={worktree}
          selected={`stash:${hash}`}
          files={files}
        />
      )}
      emptyMessage="This stash holds no file changes."
    />
  );
}

function StashMoves({
  worktree,
  stash,
}: {
  worktree: Worktree;
  stash: StashEntry;
}) {
  const { nav } = useRouteWorktree();
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
                toChanges();
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
