import { useRef, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { BranchLabel } from "@/components/ui/branch-label";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { useRenameBranch } from "@/hooks/worktrees/useWorktreeBranchOps";
import { sanitizeBranchName } from "@shared/branches";
import type { Worktree } from "@shared/schemas";
import { BranchSwitcher } from "./BranchSwitcher";

export function BranchTitle({ worktree }: { worktree: Worktree }) {
  // null while idle; the in-flight edit value otherwise. Folds "editing"
  // and "draft" together so we don't seed state from a prop.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const rename = useRenameBranch();
  const titleRef = useRef<HTMLHeadingElement>(null);

  const begin = () => {
    // Detached HEAD has no branch to rename — guard against any caller
    // (incl. future keybindings) that bypasses the hidden pencil button.
    if (worktree.detached) return;
    rename.reset();
    setDraft(worktree.branch);
  };
  const cancel = () => {
    setDraft(null);
    rename.reset();
  };
  const commit = () => {
    const next = (draft ?? "").trim();
    if (!next || next === worktree.branch) {
      cancel();
      return;
    }
    rename.mutate(
      {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        newBranch: next,
      },
      { onSuccess: () => setDraft(null) },
    );
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional: editing
          autoFocus
          value={draft ?? ""}
          disabled={rename.isPending}
          onChange={(e) => setDraft(sanitizeBranchName(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className="min-w-0 flex-1 px-2 py-1 font-mono text-2xl font-medium tracking-tight"
        />
        <button
          type="button"
          onClick={commit}
          disabled={rename.isPending}
          aria-label="Confirm rename"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Check className="size-4" />
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={rename.isPending}
          aria-label="Cancel rename"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <X className="size-4" />
        </button>
        {rename.error && (
          <span className="truncate text-xs text-destructive select-text">
            {rename.error.message}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="group/copy flex min-w-0 items-center gap-1.5">
      <h1
        ref={titleRef}
        className="min-w-0 truncate font-mono text-2xl font-medium tracking-tight"
        title={worktree.detached ? "Detached HEAD (commit hash)" : undefined}
      >
        <BranchLabel
          branch={worktree.branch}
          detached={worktree.detached}
          suffixClassName="text-base tracking-normal"
        />
      </h1>
      {!worktree.detached && (
        <button
          type="button"
          onClick={begin}
          aria-label="Rename branch"
          title="Rename branch"
          className="rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity group-hover/copy:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 phone:opacity-100"
        >
          <Pencil className="size-3.5" />
        </button>
      )}
      <BranchSwitcher worktree={worktree} anchorRef={titleRef} />
      <CopyButton
        value={worktree.branch}
        label={worktree.detached ? "Copy commit hash" : "Copy branch name"}
      />
    </div>
  );
}
