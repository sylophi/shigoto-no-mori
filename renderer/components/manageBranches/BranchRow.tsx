import { useState } from "react";
import { Check, ExternalLink, House, Pencil, Trash2, X } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import { ModalShell } from "@/components/ui/modal-shell";
import { useDeleteBranch, useRenameAnyBranch } from "@/hooks/git/useBranches";
import { cn } from "@/lib/utils";
import { sanitizeBranchName } from "@shared/branches";
import { isBranchNotMergedError } from "@shared/errors";
import type { Worktree } from "@shared/schemas";

export function BranchRow({
  projectId,
  name,
  worktree,
}: {
  projectId: string;
  name: string;
  worktree: Worktree | undefined;
}) {
  const navigate = useNavigate();
  const rename = useRenameAnyBranch();
  const del = useDeleteBranch();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // null when not editing; otherwise holds the in-flight edit value.
  // Folding "editing" and "draft" together avoids initializing local
  // state from the `name` prop.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const checkedOut = !!worktree;

  // A safe delete refused for unmerged commits swaps the modal into its
  // force-delete stage until it closes (sticky, so a transient force
  // failure doesn't drop back to the safe stage). Any other failure
  // keeps a plain retry. Close is ignored while a delete is in flight --
  // the mutation's toast is silenced in favor of the inline banner, so
  // dismissing mid-delete would swallow the failure entirely.
  const [needsForce, setNeedsForce] = useState(false);
  const closeDelete = () => {
    if (del.isPending) return;
    setConfirmingDelete(false);
    setNeedsForce(false);
    del.reset();
  };

  const commitRename = () => {
    const next = (draft ?? "").trim();
    if (!next || next === name) {
      setDraft(null);
      return;
    }
    rename.mutate(
      { projectId, oldName: name, newName: next },
      {
        onSuccess: () => setDraft(null),
        onError: () => setDraft(null),
      },
    );
  };

  return (
    <div className={cn("group flex items-center gap-3 px-3 py-2 text-sm")}>
      {editing ? (
        <Input
          value={draft ?? ""}
          onChange={(e) => setDraft(sanitizeBranchName(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setDraft(null);
          }}
          onBlur={commitRename}
          disabled={rename.isPending}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- inline edit
          autoFocus
          className="flex-1 px-2 py-1 font-mono text-sm"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono select-text">
          {name}
        </span>
      )}

      {checkedOut && !editing && (
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/projects/$projectId/worktrees/$worktreeId",
              params: { projectId, worktreeId: worktree.id },
            })
          }
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={`Checked out in ${worktree.name}`}
        >
          {worktree.isPrimary ? (
            <House className="size-3" />
          ) : worktree.isExternal ? (
            <ExternalLink className="size-3" />
          ) : null}
          <span className="truncate">{worktree.name}</span>
        </button>
      )}

      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={() => setDraft(name)}
            aria-label={`Rename ${name}`}
            title="Rename"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={checkedOut || del.isPending}
            aria-label={`Delete ${name}`}
            title={
              checkedOut
                ? "Switch to a different branch in this worktree first"
                : "Delete"
            }
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      )}

      {editing && (
        <button
          type="button"
          onMouseDown={(e) => {
            // Prevent onBlur from firing before this click is processed.
            e.preventDefault();
            setDraft(null);
          }}
          aria-label="Cancel rename"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
      {editing && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commitRename}
          aria-label="Save rename"
          disabled={rename.isPending}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Check className="size-3.5" />
        </button>
      )}

      {confirmingDelete && (
        <ModalShell onClose={closeDelete} popoverClassName="max-w-md">
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
            {del.isError && (
              <ErrorBanner className="mt-3 whitespace-pre-line">
                {isBranchNotMergedError(del.error)
                  ? "This branch has commits that aren't on any other " +
                    "branch. You can force delete it, but those commits " +
                    "are discarded permanently. If the branch was " +
                    "squash-merged, its changes already landed and nothing " +
                    "is lost."
                  : del.error.message}
              </ErrorBanner>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- focus the safe action so a stray Enter cancels
                autoFocus
                onClick={closeDelete}
                disabled={del.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={del.isPending}
                onClick={() =>
                  del.mutate(
                    { projectId, name, force: needsForce },
                    {
                      onSuccess: closeDelete,
                      onError: (err) => {
                        if (isBranchNotMergedError(err)) setNeedsForce(true);
                      },
                    },
                  )
                }
              >
                {del.isPending
                  ? "Deleting…"
                  : needsForce
                    ? "Force delete"
                    : "Delete"}
              </Button>
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
