import { useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { InlineError } from "@/components/ui/inline-error";
import { Input } from "@/components/ui/input";
import { useRenameBranch } from "@/hooks/worktrees/useWorktreeBranchOps";
import { sanitizeBranchName } from "@shared/git/branches";
import type { Worktree } from "@shared/schemas";
import { BranchSwitcher } from "./BranchSwitcher";
import { BranchTitleView } from "./BranchTitleView";
import { IconButton } from "@/components/ui/icon-button";

export function BranchTitle({ worktree }: { worktree: Worktree }) {
  // null while idle; the in-flight edit value otherwise. Folds "editing"
  // and "draft" together so we don't seed state from a prop.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const rename = useRenameBranch();
  const titleRef = useRef<HTMLHeadingElement>(null);

  const begin = () => {
    // Detached HEAD has no branch to rename, so guard against any caller
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
      <div className="flex flex-wrap items-center gap-2">
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
        <IconButton
          onClick={commit}
          disabled={rename.isPending}
          aria-label="Confirm rename"
          className="p-1.5"
        >
          <Check className="size-4" />
        </IconButton>
        <IconButton
          onClick={cancel}
          disabled={rename.isPending}
          aria-label="Cancel rename"
          className="p-1.5"
        >
          <X className="size-4" />
        </IconButton>
        {rename.error && (
          <InlineError
            message={rename.error.message}
            title="Couldn't rename the branch"
            className="basis-full text-xs text-destructive"
          />
        )}
      </div>
    );
  }

  return (
    <BranchTitleView
      branch={worktree.branch}
      detached={worktree.detached}
      onRename={begin}
      switcher={<BranchSwitcher worktree={worktree} anchorRef={titleRef} />}
      titleRef={titleRef}
    />
  );
}
