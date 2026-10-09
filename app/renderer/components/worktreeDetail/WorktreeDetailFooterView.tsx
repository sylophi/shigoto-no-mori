import { Trash2 } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { assertNever } from "@/lib/utils";
import { type CleanupError, type Worktree } from "@shigomori/contracts/schemas";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import {
  CollapsedThroughProvider,
  FooterVerbView,
  LABEL_RANK,
} from "./FooterVerbView";

// The footer is a four-state machine. The parent owns the transitions and
// hands us a discriminated state plus the actions each state can fire, so
// the footer only decides how to render, not which branch is live.
export type WorktreeFooterState =
  | { kind: "cleanupError"; error: CleanupError }
  | { kind: "needsForce"; errorMessage: string | undefined; busy: boolean }
  | { kind: "cleanupRunning"; cancelling: boolean }
  | {
      kind: "normal";
      confirmDelete: boolean;
      busy: boolean;
      // Why delete is off right now, if it is (see useDeleteAndNavigate).
      deleteBlockedReason: string | undefined;
    };

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

export interface WorktreeDetailFooterProps {
  worktree: Worktree;
  state: WorktreeFooterState;
  actions: WorktreeFooterActions;
  // The scope's own verbs (files, mirror), rendered as a leading row
  // in the quiet state only: the deletion state machine keeps the
  // whole footer once it engages.
  leading?: ReactNode;
  // Rows for the Options popover past the worktree's own switches (a
  // transfer used too rarely for a footer button of its own).
  options?: ReactNode;
  // False when a remote host has not granted this client command
  // access: the mutating affordances (shelve, delete) stay off, the
  // rest of the page is the read-only mirror.
  canMutate?: boolean;
}

// The footer (WorktreeDetailFooter measures it): on a narrow pane the
// verbs give up their labels one at a time rather than run into each
// other (footerFit.ts), as far as `collapsedThrough` says.
export function WorktreeDetailFooterView({
  worktree,
  state,
  actions,
  leading,
  canMutate = true,
  agents,
  optionsMenu,
  footerRef,
  leadingRef,
  collapsedThrough = 0,
}: Omit<WorktreeDetailFooterProps, "options"> & {
  // The agents' menu (AgentSessionsMenu) and the Options popover
  // (WorktreeOptions), in the quiet state.
  agents?: ReactNode;
  optionsMenu: ReactNode;
  footerRef?: Ref<HTMLElement>;
  leadingRef?: Ref<HTMLDivElement>;
  collapsedThrough?: number;
}) {
  return (
    <CollapsedThroughProvider value={collapsedThrough}>
      <footer
        ref={footerRef}
        className="flex h-9.5 items-center gap-3 border-t border-border bg-card px-6 phone:h-11 phone:px-4"
      >
        {state.kind === "normal" && leading && (
          <div ref={leadingRef} className="flex min-w-0 items-center gap-1">
            {leading}
          </div>
        )}
        {canMutate ? (
          renderFooterContent(worktree, state, actions, agents, optionsMenu)
        ) : (
          <span className="ml-auto text-xs text-muted-foreground">
            {peerReadOnlyNote()}
          </span>
        )}
      </footer>
    </CollapsedThroughProvider>
  );
}

function renderFooterContent(
  worktree: Worktree,
  state: WorktreeFooterState,
  actions: WorktreeFooterActions,
  agents: ReactNode,
  optionsMenu: ReactNode,
): ReactNode {
  switch (state.kind) {
    case "cleanupError":
      return <CleanupErrorRow {...state} actions={actions} />;
    case "needsForce":
      return <NeedsForceRow {...state} actions={actions} />;
    case "cleanupRunning":
      return (
        <CleanupRunningRow
          {...state}
          onCancelCleanup={actions.onCancelCleanup}
        />
      );
    case "normal":
      return (
        <NormalRow
          worktree={worktree}
          {...state}
          agents={agents}
          optionsMenu={optionsMenu}
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
        variant="ghost-destructive"
        size="xs"
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
      <InlineError
        message={errorMessage ?? "Has uncommitted changes."}
        title="Couldn't delete the worktree"
        className="flex-1 text-xs text-destructive"
      />
      <Button
        variant="ghost"
        size="xs"
        onClick={actions.onCancelForce}
        disabled={busy}
      >
        Cancel
      </Button>
      <Button
        variant="ghost-destructive"
        size="xs"
        className="shrink-0"
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
      variant="ghost-destructive"
      size="xs"
      onClick={onCancelCleanup}
      disabled={cancelling}
      className="ml-auto shrink-0"
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
  deleteBlockedReason,
  agents,
  optionsMenu,
  onDelete,
}: {
  worktree: Worktree;
  confirmDelete: boolean;
  busy: boolean;
  deleteBlockedReason: string | undefined;
  agents: ReactNode;
  optionsMenu: ReactNode;
  onDelete: () => void;
}) {
  return (
    <div className="ml-auto flex items-center gap-3">
      {agents}
      {optionsMenu}
      {!worktree.isPrimary && (
        <FooterVerbView
          // Armed or deleting, the label stays: an icon alone can't ask
          // for the second click.
          rank={busy || confirmDelete ? undefined : LABEL_RANK.delete}
          icon={<Trash2 />}
          label={deleteButtonLabel(busy, confirmDelete)}
          variant="ghost-destructive"
          className="shrink-0"
          aria-pressed={confirmDelete}
          disabled={busy || deleteBlockedReason !== undefined}
          onClick={onDelete}
          tip={deleteBlockedReason}
        />
      )}
    </div>
  );
}

function deleteButtonLabel(busy: boolean, armed: boolean): string {
  if (busy) return "Deleting…";
  return armed ? "Confirm delete?" : "Delete worktree";
}
