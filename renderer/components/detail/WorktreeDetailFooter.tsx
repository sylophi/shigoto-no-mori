import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSetShelved } from "@/hooks/worktrees/useWorktreeMutations";
import { cn } from "@/lib/utils";
import type { CleanupError, Worktree } from "@shared/schemas";

function deleteButtonLabel(busy: boolean, armed: boolean): string {
  if (busy) return "Deleting…";
  return armed ? "Confirm delete?" : "Delete worktree";
}

interface WorktreeDetailFooterProps {
  worktree: Worktree;
  cleanupError: CleanupError | null;
  needsForce: boolean;
  cleanupRunning: boolean;
  busy: boolean;
  confirmDelete: boolean;
  cleanupCancelling: boolean;
  deleteErrorMessage: string | undefined;
  onCancelCleanupError: () => void;
  onOpenCleanupConsole: () => void;
  onRetryCleanup: () => void;
  onSkipCleanup: () => void;
  onCancelForce: () => void;
  onForceDelete: () => void;
  onCancelCleanup: () => void;
  onDelete: () => void;
}

export function WorktreeDetailFooter({
  worktree,
  cleanupError,
  needsForce,
  cleanupRunning,
  busy,
  confirmDelete,
  cleanupCancelling,
  deleteErrorMessage,
  onCancelCleanupError,
  onOpenCleanupConsole,
  onRetryCleanup,
  onSkipCleanup,
  onCancelForce,
  onForceDelete,
  onCancelCleanup,
  onDelete,
}: WorktreeDetailFooterProps) {
  const setShelved = useSetShelved();

  return (
    <footer className="flex h-[38px] items-center gap-3 border-t border-border bg-card px-6">
      {cleanupError ? (
        <>
          <span className="min-w-0 flex-1 truncate text-xs text-destructive select-text">
            {cleanupError.phase === "teardown"
              ? "Teardown didn't complete cleanly"
              : "Port-pool release didn't complete cleanly"}{" "}
            (exit{" "}
            {cleanupError.exitCode === null ? "errored" : cleanupError.exitCode}
            ).
          </span>
          <Button variant="ghost" size="xs" onClick={onCancelCleanupError}>
            Cancel
          </Button>
          <Button variant="ghost" size="xs" onClick={onOpenCleanupConsole}>
            View output
          </Button>
          <Button variant="ghost" size="xs" onClick={onRetryCleanup}>
            Retry
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onSkipCleanup}
          >
            <Trash2 />
            Skip cleanup
          </Button>
        </>
      ) : needsForce ? (
        <>
          <span className="min-w-0 flex-1 truncate text-xs text-destructive select-text">
            {deleteErrorMessage ?? "Has uncommitted changes."}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={onCancelForce}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            onClick={onForceDelete}
          >
            <Trash2 />
            {busy ? "Deleting..." : "Force delete"}
          </Button>
        </>
      ) : cleanupRunning ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={onCancelCleanup}
          disabled={cleanupCancelling}
          className="ml-auto shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 />
          {cleanupCancelling ? "Stopping..." : "Stop cleanup"}
        </Button>
      ) : (
        <div className="ml-auto flex items-center gap-3">
          {!worktree.isPrimary && !worktree.isExternal && (
            <Button
              variant="ghost"
              size="xs"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              disabled={setShelved.isPending || busy}
              onClick={() =>
                setShelved.mutate({
                  projectId: worktree.projectId,
                  worktreeId: worktree.id,
                  shelved: !worktree.shelved,
                })
              }
              title={
                worktree.shelved
                  ? "Unshelve (bring back to the main list)"
                  : "Shelve (hide from the main list)"
              }
            >
              {worktree.shelved ? <ArchiveRestore /> : <Archive />}
              {worktree.shelved ? "Unshelve" : "Shelve"}
            </Button>
          )}
          {!worktree.isPrimary && (
            <Button
              variant="ghost"
              size="xs"
              className={cn(
                "shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive",
                confirmDelete && "bg-destructive/10",
              )}
              disabled={busy}
              onClick={onDelete}
              title={
                confirmDelete ? "Click again to confirm" : "Delete worktree"
              }
            >
              <Trash2 />
              {deleteButtonLabel(busy, confirmDelete)}
            </Button>
          )}
        </div>
      )}
    </footer>
  );
}
