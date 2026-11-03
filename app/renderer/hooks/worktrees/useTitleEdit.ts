// The edit of the worktree's title (EditableTitleView, in the page's
// header), its own or its open PR's, saved through the engine's
// describe. `editable` is whether this title can be changed at all.
import { useState } from "react";
import type { Worktree } from "@shigomori/contracts/schemas";
import type { TitleEdit } from "@shigomori/ui/views/worktreeDetail/EditableTitleView.tsx";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useDescribeWorktree } from "@/hooks/worktrees/useWorktreeMutations";

export function useTitleEdit(worktree: Worktree, editable: boolean): TitleEdit {
  const [editing, setEditing] = useState(false);
  const describe = useDescribeWorktree("Couldn't save the title");
  const { canCommand } = useCommandAccess();

  const cancel = () => setEditing(false);
  return {
    editing,
    saving: describe.isPending,
    ...(canCommand && editable ? { onEdit: () => setEditing(true) } : {}),
    onSave: (next) =>
      describe.mutate(
        { projectId: worktree.projectId, worktreeId: worktree.id, title: next },
        { onSuccess: cancel },
      ),
    onCancel: cancel,
  };
}
