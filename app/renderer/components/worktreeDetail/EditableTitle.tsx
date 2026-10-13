import { useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useDescribeWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import type { Worktree } from "@shared/schemas";

// The worktree's title (`sm describe`, its open PR's while one holds
// it), edited in place like the branch under it. `children` follow the
// title in its heading (the PR's number). The field is pulled back by
// its padding and border so the text stays put. Cleared, the branch
// names the work again (a PR's can't be).
export function EditableTitle({
  worktree,
  title,
  editable,
  children,
}: {
  worktree: Worktree;
  title: string;
  editable: boolean;
  children?: React.ReactNode;
}) {
  // The edit in progress, or null while idle.
  const [draft, setDraft] = useState<string | null>(null);
  const describe = useDescribeWorktree("Couldn't save the title");
  const { canCommand } = useCommandAccess();

  const cancel = () => setDraft(null);
  const commit = () => {
    const next = (draft ?? "").trim();
    if (next === title) return cancel();
    describe.mutate(
      { projectId: worktree.projectId, worktreeId: worktree.id, title: next },
      { onSuccess: cancel },
    );
  };

  if (draft !== null) {
    return (
      <div className="flex min-w-0 grow items-center gap-2">
        <Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional: editing
          autoFocus
          aria-label="Title"
          value={draft}
          disabled={describe.isPending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className="-ml-2.25 h-8 min-w-0 flex-1 px-2 py-0 text-2xl font-medium tracking-tight"
        />
        <IconButton
          onClick={commit}
          disabled={describe.isPending}
          aria-label="Save title"
          className="p-1.5"
        >
          <Check className="size-4" />
        </IconButton>
        <IconButton
          onClick={cancel}
          disabled={describe.isPending}
          aria-label="Cancel"
          className="p-1.5"
        >
          <X className="size-4" />
        </IconButton>
      </div>
    );
  }

  return (
    <div className="group/title flex min-w-0 items-center gap-1.5">
      <h1 className="flex min-w-0 items-baseline gap-1.5 text-2xl font-medium tracking-tight select-text">
        <SimpleTooltip whenTruncated tip={title}>
          <span className="min-w-0 truncate">{title}</span>
        </SimpleTooltip>
        {children}
      </h1>
      {canCommand && editable && (
        <IconButton
          onClick={() => setDraft(title)}
          aria-label="Edit title"
          className="shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover/title:opacity-100 focus-visible:opacity-100 phone:opacity-100"
        >
          <Pencil className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}
