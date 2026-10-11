// The edit of the worktree's own title (OwnTitleView, in the page's
// header), saved through the engine's describe.
import { useState } from "react";
import type { Worktree } from "@shigomori/contracts/schemas";
import type { OwnTitleEdit } from "@shigomori/ui/views/worktreeDetail/OwnTitleView.tsx";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useDescribeWorktree } from "@/hooks/worktrees/useWorktreeMutations";

export function useOwnTitleEdit(
  worktree: Worktree,
  title: string,
): OwnTitleEdit {
  const [draft, setDraft] = useState<string | null>(null);
  const describe = useDescribeWorktree("Couldn't save the title");
  const { canCommand } = useCommandAccess();

  const cancel = () => setDraft(null);
  return {
    draft,
    saving: describe.isPending,
    ...(canCommand ? { onEdit: () => setDraft(title) } : {}),
    onDraft: setDraft,
    onCommit: () => {
      const next = (draft ?? "").trim();
      if (next === title) return cancel();
      describe.mutate(
        { projectId: worktree.projectId, worktreeId: worktree.id, title: next },
        { onSuccess: cancel },
      );
    },
    onCancel: cancel,
  };
}
