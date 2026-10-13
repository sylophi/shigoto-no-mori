// The worktree's title (`sm describe`, its open PR's while one holds
// it), edited in place like the branch under it (useTitleEdit binds
// it). `children` follow the title in its heading (the PR's number).
// The field is pulled back by its padding and border so the text stays
// put. Cleared, the branch names the work again (a PR's can't be).
import type { ReactNode } from "react";
import { Check, Pencil, X } from "lucide-react";
import { IconButton } from "../../primitives/icon-button.tsx";
import { Input } from "../../primitives/input.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";

export type TitleEdit = {
  // The edit in progress, or null while idle.
  draft: string | null;
  saving: boolean;
  // Absent where the title can't be changed from here.
  onEdit?: () => void;
  onDraft: (draft: string) => void;
  onCommit: () => void;
  onCancel: () => void;
};

export function EditableTitleView({
  title,
  edit,
  children,
}: {
  title: string;
  edit?: TitleEdit;
  children?: ReactNode;
}) {
  if (edit && edit.draft !== null) {
    return (
      <div className="flex min-w-0 grow items-center gap-2">
        <Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional: editing
          autoFocus
          aria-label="Title"
          value={edit.draft}
          disabled={edit.saving}
          onChange={(e) => edit.onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              edit.onCommit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              edit.onCancel();
            }
          }}
          className="-ml-2.25 h-8 min-w-0 flex-1 px-2 py-0 text-2xl font-medium tracking-tight"
        />
        <IconButton
          onClick={edit.onCommit}
          disabled={edit.saving}
          aria-label="Save title"
          className="p-1.5"
        >
          <Check className="size-4" />
        </IconButton>
        <IconButton
          onClick={edit.onCancel}
          disabled={edit.saving}
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
      {edit?.onEdit && (
        <IconButton
          onClick={edit.onEdit}
          aria-label="Edit title"
          className="shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover/title:opacity-100 focus-visible:opacity-100 phone:opacity-100"
        >
          <Pencil className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}
