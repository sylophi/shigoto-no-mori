import {
  Archive,
  ArchiveRestore,
  RefreshCw,
  RefreshCwOff,
  Trash2,
} from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { assertNever } from "@/lib/utils";
import {
  isManagedWorktree,
  type CleanupError,
  type Worktree,
} from "@shared/schemas";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { CollapsedThroughProvider, FooterVerb, LABEL_RANK } from "./footerFit";

// The worktree page's footer as drawn (WorktreeDetailFooter.tsx feeds
// it and fits its labels to the pane): the leading verbs, then
// auto-pull, shelve and delete, or the deletion's own row.

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

// The quiet state's own toggles.
export interface WorktreeFooterToggles {
  autoPullPending?: boolean;
  shelvePending?: boolean;
  onToggleAutoPull?: () => void;
  onToggleShelved?: () => void;
}

const noop = () => undefined;

const NO_TOGGLES: WorktreeFooterToggles = {};

const NO_ACTIONS: WorktreeFooterActions = {
  onCancelCleanupError: noop,
  onOpenCleanupConsole: noop,
  onRetryCleanup: noop,
  onSkipCleanup: noop,
  onCancelForce: noop,
  onForceDelete: noop,
  onCancelCleanup: noop,
  onDelete: noop,
};

export interface WorktreeDetailFooterViewProps {
  worktree: Worktree;
  state: WorktreeFooterState;
  actions?: WorktreeFooterActions;
  toggles?: WorktreeFooterToggles;
  // The scope's own verbs (ports, mirror, transplant), rendered as a
  // leading row in the quiet state only: the deletion state machine
  // keeps the whole footer once it engages.
  leading?: ReactNode;
  // False when a remote host has not granted this client command
  // access: the mutating affordances (shelve, delete) stay off, the
  // rest of the page is the read-only mirror.
  canMutate?: boolean;
  // What the fit measures (footerFit.tsx useFittedLabels), and how far
  // it collapsed the labels.
  footerRef?: Ref<HTMLElement>;
  leadingRef?: Ref<HTMLDivElement>;
  collapsedThrough?: number;
}

export function WorktreeDetailFooterView({
  worktree,
  state,
  actions = NO_ACTIONS,
  toggles = NO_TOGGLES,
  leading,
  canMutate = true,
  footerRef,
  leadingRef,
  collapsedThrough = 0,
}: WorktreeDetailFooterViewProps) {
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
          renderFooterContent(worktree, state, actions, toggles)
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
  toggles: WorktreeFooterToggles,
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
          {...toggles}
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
  autoPullPending = false,
  shelvePending = false,
  onToggleAutoPull,
  onToggleShelved,
  onDelete,
}: WorktreeFooterToggles & {
  worktree: Worktree;
  confirmDelete: boolean;
  busy: boolean;
  deleteBlockedReason: string | undefined;
  onDelete: () => void;
}) {
  // Offered wherever a fast-forward could ever happen. Once on, it
  // stays visible even if the upstream vanishes, so it can be turned
  // off again.
  const canAutoPull =
    worktree.autoPull || (worktree.hasUpstream && !worktree.detached);
  const autoPullUi = AUTO_PULL_UI[worktree.autoPull ? "on" : "off"];

  return (
    <div className="ml-auto flex items-center gap-3">
      {canAutoPull && (
        <FooterVerb
          rank={LABEL_RANK.autoPull}
          icon={<autoPullUi.Icon />}
          label={autoPullUi.label}
          variant="ghost"
          className={autoPullUi.className}
          aria-pressed={worktree.autoPull}
          disabled={autoPullPending || busy}
          onClick={onToggleAutoPull}
          title={autoPullUi.title}
        />
      )}
      {isManagedWorktree(worktree) && (
        <FooterVerb
          rank={LABEL_RANK.shelve}
          icon={worktree.shelved ? <ArchiveRestore /> : <Archive />}
          label={worktree.shelved ? "Unshelve" : "Shelve"}
          variant="ghost"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          disabled={shelvePending || busy}
          onClick={onToggleShelved}
          title={
            worktree.shelved
              ? "Unshelve (bring back to the main list)"
              : "Shelve (hide from the main list)"
          }
        />
      )}
      {!worktree.isPrimary && (
        <FooterVerb
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
          title={
            deleteBlockedReason ??
            (confirmDelete ? "Click again to confirm" : "Delete worktree")
          }
        />
      )}
    </div>
  );
}

// The auto-pull toggle's two faces. On is sky like the header's pull
// pill, since that is the action it automates.
const AUTO_PULL_UI = {
  on: {
    Icon: RefreshCw,
    label: "Auto-pull on",
    className:
      "shrink-0 text-sky-600 hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300",
    title:
      "Auto-pull is on: this worktree fast-forwards from its upstream after each fetch while it has no local commits, changes or running scripts. Click to turn off.",
  },
  off: {
    Icon: RefreshCwOff,
    label: "Auto-pull",
    className: "shrink-0 text-muted-foreground hover:text-foreground",
    title:
      "Auto-pull: fast-forward from the upstream automatically while this worktree has no local commits, changes or running scripts",
  },
};

function deleteButtonLabel(busy: boolean, armed: boolean): string {
  if (busy) return "Deleting…";
  return armed ? "Confirm delete?" : "Delete worktree";
}
