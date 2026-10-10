import type { ReactNode } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { ErrorBanner } from "@shigomori/ui/primitives/error-banner.tsx";
import { Input } from "@shigomori/ui/primitives/input.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { sanitizeBranchName } from "@shared/git/branches";
import type { Worktree } from "@shigomori/contracts/schemas";
import { IconButton } from "@shigomori/ui/primitives/icon-button.tsx";

// One local branch: its name, renamed in place, the worktree it is
// checked out in, and its removal (BranchRow.tsx binds them).
export function BranchRowView({
  name,
  worktree,
  kindIcon,
  draft,
  onDraft,
  renamePending,
  onCommitRename,
  onOpenWorktree,
  onDelete,
  deletePending,
  deleteDialog,
}: {
  name: string;
  // The worktree it is checked out in.
  worktree: Worktree | undefined;
  // That worktree's kind (WorktreeKindIcon), for a primary or external
  // one.
  kindIcon: ReactNode;
  // null when not editing; otherwise the in-flight edit value.
  draft: string | null;
  onDraft: (draft: string | null) => void;
  renamePending: boolean;
  onCommitRename: () => void;
  onOpenWorktree: () => void;
  onDelete: () => void;
  deletePending: boolean;
  // The delete's confirm, while it is up.
  deleteDialog: ReactNode;
}) {
  const editing = draft !== null;
  const checkedOut = !!worktree;

  return (
    <div className={cn("group flex items-center gap-3 px-3 py-2 text-sm")}>
      {editing ? (
        <Input
          value={draft ?? ""}
          onChange={(e) => onDraft(sanitizeBranchName(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename();
            if (e.key === "Escape") onDraft(null);
          }}
          onBlur={onCommitRename}
          disabled={renamePending}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- inline edit
          autoFocus
          className="flex-1 px-2 py-1 font-mono text-sm"
        />
      ) : (
        <SimpleTooltip whenTruncated tip={name}>
          <span className="min-w-0 flex-1 truncate font-mono select-text">
            {name}
          </span>
        </SimpleTooltip>
      )}

      {worktree !== undefined && !editing && (
        <button
          type="button"
          onClick={onOpenWorktree}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {(worktree.isPrimary || worktree.isExternal) && kindIcon}
          <span className="truncate">{worktree.name}</span>
        </button>
      )}

      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 phone:opacity-100">
          <IconButton
            onClick={() => onDraft(name)}
            aria-label={`Rename ${name}`}
          >
            <Pencil className="size-3.5" />
          </IconButton>
          <SimpleTooltip
            tip={
              checkedOut
                ? "Switch to a different branch in this worktree first"
                : undefined
            }
          >
            <IconButton
              onClick={onDelete}
              disabled={checkedOut || deletePending}
              aria-label={`Delete ${name}`}
              tone="destructive"
              className="disabled:opacity-30"
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </SimpleTooltip>
        </div>
      )}

      {editing && (
        <IconButton
          onMouseDown={(e) => {
            // Prevent onBlur from firing before this click is processed.
            e.preventDefault();
            onDraft(null);
          }}
          aria-label="Cancel rename"
        >
          <X className="size-3.5" />
        </IconButton>
      )}
      {editing && (
        <IconButton
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCommitRename}
          aria-label="Save rename"
          disabled={renamePending}
        >
          <Check className="size-3.5" />
        </IconButton>
      )}

      {deleteDialog}
    </div>
  );
}

// The delete's confirm: a safe delete first, and once git refuses it
// for unmerged commits, a force delete (BranchRow puts it in a
// ModalShell).
export function BranchDeleteDialogView({
  name,
  needsForce,
  error,
  pending,
  onCancel,
  onDelete,
}: {
  name: string;
  needsForce: boolean;
  // The delete's failure: git's refusal over unmerged commits, or any
  // other.
  error: { notMerged: boolean; message: string } | null;
  pending: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="p-5">
      <h2 className="text-base font-semibold">Delete branch</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Delete the local branch{" "}
        <span className="font-mono text-foreground">{name}</span>?{" "}
        {needsForce
          ? "Force deleting cannot be undone."
          : "You'll be asked again if it has commits that aren't " +
            "merged elsewhere."}
      </p>
      {error !== null &&
        (error.notMerged ? (
          <ErrorBanner className="mt-3">
            This branch has commits that aren&apos;t on any other branch. You
            can force delete it, but those commits are discarded permanently. If
            the branch was squash-merged, its changes already landed and nothing
            is lost.
          </ErrorBanner>
        ) : (
          <ErrorBanner
            className="mt-3"
            message={error.message}
            title="Couldn't delete the branch"
          />
        ))}
      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- focus the safe action so a stray Enter cancels
          autoFocus
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={pending}
          onClick={onDelete}
        >
          {pending ? "Deleting…" : needsForce ? "Force delete" : "Delete"}
        </Button>
      </div>
    </div>
  );
}
