import { ErrorBanner } from "@/components/ui/error-banner";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { StackCleanupFailure } from "@/hooks/worktrees/useWorktreeMutations";
import { cn } from "@/lib/utils";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";

export const STACK_ERROR_TITLE = "Couldn't delete the stack's worktrees";

export type DeleteReach = "one" | "stack";

// What a failed stack removal is offered: force for a refusal (a
// dirty worktree), a retry or skipping the scripts for a cleanup
// script that failed, nothing but the message for a peer that will
// not run commands from here.
export interface StackError {
  message: string;
  kind: StackCleanupFailure["kind"];
}

export interface StackRunOptions {
  force?: boolean;
  skipCleanup?: boolean;
}

export function ClosedPullRequestBoxView({
  count,
  reach,
  armed,
  deletePending,
  stackPending,
  deleteBlockedReason,
  blockedNote,
  stackError,
  deleteError,
  onDelete,
  onDeleteStack,
  onRunStack,
  onPickReach,
  onDismissStackError,
}: {
  // The stack worktrees the menu can reach, 0 or 1 when there is no
  // stack to take along.
  count: number;
  reach: DeleteReach;
  armed: boolean;
  deletePending: boolean;
  stackPending: boolean;
  deleteBlockedReason?: string;
  blockedNote: string | null;
  stackError: StackError | null;
  deleteError: string | null;
  // Asked twice, through the confirm.
  onDelete: () => void;
  onDeleteStack: () => void;
  // Run at once, offered after a failure.
  onRunStack: (opts?: StackRunOptions) => void;
  onPickReach: (reach: DeleteReach) => void;
  onDismissStackError: () => void;
}) {
  const pending = stackPending || deletePending;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {count > 1 && stackError && stackError.kind !== "refused" ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onDismissStackError}
            >
              Cancel
            </Button>
            <ConfirmDestructiveButton
              armed={armed}
              pending={deletePending}
              disabled={stackPending}
              pendingLabel="Deleting…"
              idleLabel="Delete worktree"
              onClick={onDelete}
              disabledReason={deleteBlockedReason}
            />
            {stackError.kind === "cleanup" ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onRunStack()}
                >
                  Retry
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={pending}
                  onClick={() => onRunStack({ skipCleanup: true })}
                >
                  Skip cleanup scripts
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => onRunStack({ force: true })}
              >
                Delete {count} stack worktrees anyway
              </Button>
            )}
          </>
        ) : (
          // One button, and with landed layers to take along, a menu
          // beside it that sets how far it reaches, the way the merge
          // button's sets its method. This worktree by default: taking
          // more than the page you are on is the surprise to avoid.
          <div className="inline-flex items-stretch">
            <ConfirmDestructiveButton
              armed={armed}
              {...(reach === "stack"
                ? {
                    pending: stackPending,
                    disabled: deletePending,
                    pendingLabel: "Deleting stack…",
                    idleLabel: `Delete ${count} stack worktrees`,
                    onClick: onDeleteStack,
                  }
                : {
                    pending: deletePending,
                    disabled: stackPending,
                    pendingLabel: "Deleting…",
                    idleLabel: "Delete worktree",
                    onClick: onDelete,
                    disabledReason: deleteBlockedReason,
                  })}
              className={cn(count > 1 && "rounded-r-none border-r-0")}
            />
            {count > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline-destructive"
                      disabled={pending}
                      aria-label="Choose what to delete"
                      className="rounded-l-none px-1.5"
                    >
                      <ChevronDown aria-hidden className="size-3.5" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" sideOffset={4}>
                  {(
                    [
                      ["one", "This worktree"],
                      ["stack", `All ${count} stack worktrees`],
                    ] as const
                  ).map(([value, label]) => (
                    <DropdownMenuItem
                      key={value}
                      onClick={() => onPickReach(value)}
                    >
                      <span className="flex-1">{label}</span>
                      {reach === value && (
                        <Check
                          aria-hidden
                          className="size-3.5 text-muted-foreground"
                        />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
      {blockedNote && (
        <p className="text-right text-xs text-muted-foreground">
          {blockedNote}
        </p>
      )}
      {stackError && (
        <ErrorBanner message={stackError.message} title={STACK_ERROR_TITLE} />
      )}
      {deleteError && (
        <ErrorBanner
          message={deleteError}
          title="Couldn't delete the worktree"
        />
      )}
    </div>
  );
}
