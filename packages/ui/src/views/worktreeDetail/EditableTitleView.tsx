// The worktree's title (`sm describe`, its open PR's while one holds
// it), edited in place like the branch under it (useTitleEdit binds
// it). `children` follow the title in its heading (the PR's number).
// Cleared, the branch names the work again (a PR's can't be).
import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import { IconButton } from "../../primitives/icon-button.tsx";
import { InlineEdit } from "../../primitives/inline-edit.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";

export type TitleEdit = {
  editing: boolean;
  saving: boolean;
  // Absent where the title can't be changed from here.
  onEdit?: () => void;
  onSave: (title: string) => void;
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
  if (edit?.editing) {
    return (
      <InlineEdit
        variant="icons"
        size="title"
        value={title}
        label="Title"
        pending={edit.saving}
        allowBlank
        onSave={edit.onSave}
        onCancel={edit.onCancel}
      />
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
          reveal
          className="group-hover/title:opacity-100"
        >
          <Pencil className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}
