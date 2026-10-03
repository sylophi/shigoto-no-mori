// The cleanup box under a closed PR as drawn (ClosedPullRequestBox.tsx
// runs the removals): Delete worktree, and for a stack with landed
// layers on several worktrees the stack's cleanup beside it, with what
// a failed stack removal can still do and why devices were left out.
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";
import { ErrorBanner } from "@/components/ui/error-banner";

export const STACK_ERROR_TITLE = "Couldn't delete the stack's worktrees";

export interface StackCleanupError {
  message: string;
  // What the box offers next (StackCleanupFailure's kind): a retry or
  // skipping the scripts for a cleanup script that failed, force for
  // anything else (a dirty worktree above all), and nothing but the
  // message for a peer that will not run commands from here.
  kind: "cleanup" | "refused" | "error";
}

export function ClosedPullRequestBoxView({
  stackCount,
  armed = false,
  stackArmed = false,
  pending = false,
  stackPending = false,
  deleteBlockedReason,
  blockedNote,
  stackError = null,
  deleteError,
  onDelete,
  onDeleteStack,
  onCancelStackError,
  onRetryStack,
  onSkipStackCleanup,
  onForceStack,
}: {
  // How many worktrees the stack's cleanup takes. Shown past one.
  stackCount: number;
  armed?: boolean;
  stackArmed?: boolean;
  // The worktree's own removal under way.
  pending?: boolean;
  stackPending?: boolean;
  deleteBlockedReason?: string;
  // The devices the stack cleanup can't reach, in a sentence.
  blockedNote?: string;
  stackError?: StackCleanupError | null;
  deleteError?: string;
  onDelete?: () => void;
  onDeleteStack?: () => void;
  onCancelStackError?: () => void;
  onRetryStack?: () => void;
  onSkipStackCleanup?: () => void;
  onForceStack?: () => void;
}) {
  const busy = stackPending || pending;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        {stackCount > 1 &&
          (stackError && stackError.kind !== "refused" ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onCancelStackError}
              >
                Cancel
              </Button>
              {stackError.kind === "cleanup" ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={onRetryStack}
                  >
                    Retry
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={onSkipStackCleanup}
                  >
                    Skip cleanup scripts
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={onForceStack}
                >
                  Delete {stackCount} stack worktrees anyway
                </Button>
              )}
            </>
          ) : (
            <ConfirmDestructiveButton
              armed={stackArmed}
              pending={stackPending}
              disabled={pending}
              pendingLabel="Deleting stack…"
              idleLabel={`Delete ${stackCount} stack worktrees`}
              onClick={() => onDeleteStack?.()}
            />
          ))}
        <ConfirmDestructiveButton
          armed={armed}
          pending={pending}
          disabled={stackPending}
          pendingLabel="Deleting…"
          idleLabel="Delete worktree"
          onClick={() => onDelete?.()}
          disabledReason={deleteBlockedReason}
        />
      </div>
      {blockedNote && (
        <p className="text-right text-xs text-muted-foreground">
          {blockedNote}
        </p>
      )}
      {stackError && (
        <ErrorBanner message={stackError.message} title={STACK_ERROR_TITLE} />
      )}
      {deleteError !== undefined && (
        <ErrorBanner
          message={deleteError}
          title="Couldn't delete the worktree"
        />
      )}
    </div>
  );
}
