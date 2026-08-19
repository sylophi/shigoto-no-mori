import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useSetShelved } from "@/hooks/worktrees/useWorktreeMutations";
import { assertNever, cn } from "@/lib/utils";
import {
  isManagedWorktree,
  type CleanupError,
  type Worktree,
} from "@shared/schemas";

// The footer is a four-state machine. The parent owns the transitions and
// hands us a discriminated state plus the actions each state can fire, so
// the footer only decides how to render, not which branch is live.
export type WorktreeFooterState =
  | { kind: "cleanupError"; error: CleanupError }
  | { kind: "needsForce"; errorMessage: string | undefined; busy: boolean }
  | { kind: "cleanupRunning"; cancelling: boolean }
  | { kind: "normal"; confirmDelete: boolean; busy: boolean };

export interface WorktreeFooterActions {
  onCancelCleanupError: () => void;
  onOpenCleanupConsole: () => void;
  onRetryCleanup: () => void;
  onSkipCleanup: () => void;
  onCancelForce: () => void;
  onForceDelete: () => void;
  onCancelCleanup: () => void;
  onDelete: () => void;
}

interface WorktreeDetailFooterProps {
  worktree: Worktree;
  state: WorktreeFooterState;
  actions: WorktreeFooterActions;
}

export function WorktreeDetailFooter({
  worktree,
  state,
  actions,
}: WorktreeDetailFooterProps) {
  return (
    <footer className="flex h-[38px] items-center gap-3 border-t border-border bg-card px-6">
      {renderFooterContent(worktree, state, actions)}
    </footer>
  );
}

function renderFooterContent(
  worktree: Worktree,
  state: WorktreeFooterState,
  actions: WorktreeFooterActions,
): ReactNode {
  switch (state.kind) {
    case "cleanupError":
      return <CleanupErrorRow error={state.error} actions={actions} />;
    case "needsForce":
      return (
        <NeedsForceRow
          errorMessage={state.errorMessage}
          busy={state.busy}
          actions={actions}
        />
      );
    case "cleanupRunning":
      return (
        <CleanupRunningRow
          cancelling={state.cancelling}
          onCancelCleanup={actions.onCancelCleanup}
        />
      );
    case "normal":
      return (
        <NormalRow
          worktree={worktree}
          confirmDelete={state.confirmDelete}
          busy={state.busy}
          onDelete={actions.onDelete}
        />
      );
    default:
      return assertNever(state);
  }
}

function CleanupErrorRow({
  error,
  actions,
}: {
  error: CleanupError;
  actions: WorktreeFooterActions;
}) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate text-xs text-destructive select-text">
        {error.phase === "teardown"
          ? "Teardown didn't complete cleanly"
          : "Port-pool release didn't complete cleanly"}{" "}
        (exit {error.exitCode === null ? "errored" : error.exitCode}).
      </span>
      <Button variant="ghost" size="xs" onClick={actions.onCancelCleanupError}>
        Cancel
      </Button>
      <Button variant="ghost" size="xs" onClick={actions.onOpenCleanupConsole}>
        View output
      </Button>
      <Button variant="ghost" size="xs" onClick={actions.onRetryCleanup}>
        Retry
      </Button>
      <Button
        variant="ghost"
        size="xs"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={actions.onSkipCleanup}
      >
        <Trash2 />
        Skip cleanup
      </Button>
    </>
  );
}

function NeedsForceRow({
  errorMessage,
  busy,
  actions,
}: {
  errorMessage: string | undefined;
  busy: boolean;
  actions: WorktreeFooterActions;
}) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate text-xs text-destructive select-text">
        {errorMessage ?? "Has uncommitted changes."}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={actions.onCancelForce}
        disabled={busy}
      >
        Cancel
      </Button>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={busy}
        onClick={actions.onForceDelete}
      >
        <Trash2 />
        {busy ? "Deleting..." : "Force delete"}
      </Button>
    </>
  );
}

function CleanupRunningRow({
  cancelling,
  onCancelCleanup,
}: {
  cancelling: boolean;
  onCancelCleanup: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onCancelCleanup}
      disabled={cancelling}
      className="ml-auto shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
    >
      <Trash2 />
      {cancelling ? "Stopping..." : "Stop cleanup"}
    </Button>
  );
}

function NormalRow({
  worktree,
  confirmDelete,
  busy,
  onDelete,
}: {
  worktree: Worktree;
  confirmDelete: boolean;
  busy: boolean;
  onDelete: () => void;
}) {
  const setShelved = useSetShelved();

  return (
    <div className="ml-auto flex items-center gap-3">
      {isManagedWorktree(worktree) && (
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
          title={confirmDelete ? "Click again to confirm" : "Delete worktree"}
        >
          <Trash2 />
          {deleteButtonLabel(busy, confirmDelete)}
        </Button>
      )}
    </div>
  );
}

function deleteButtonLabel(busy: boolean, armed: boolean): string {
  if (busy) return "Deleting…";
  return armed ? "Confirm delete?" : "Delete worktree";
}
