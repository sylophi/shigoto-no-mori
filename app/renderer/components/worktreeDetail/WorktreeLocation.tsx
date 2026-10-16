// The worktree page's location (WorktreeLocationView), its rename sent
// to the device the worktree is on (the hook takes the page to the new
// id).
import { useState } from "react";
import type { Worktree } from "@shigomori/contracts/schemas";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useRenameWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { WorktreeLocationView } from "@shigomori/ui/views/worktreeDetail/WorktreeLocationView.tsx";

export function WorktreeLocation({
  worktree,
  home,
}: {
  worktree: Worktree;
  home: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const { canCommand } = useCommandAccess();
  const rename = useRenameWorktree();
  return (
    <WorktreeLocationView
      path={worktree.path}
      home={home}
      rename={
        worktree.isPrimary || !canCommand
          ? undefined
          : {
              editing,
              onEditingChange: setEditing,
              pending: rename.isPending,
              onRename: (name) =>
                rename.mutate(
                  {
                    projectId: worktree.projectId,
                    worktreeId: worktree.id,
                    name,
                  },
                  { onSuccess: () => setEditing(false) },
                ),
            }
      }
    />
  );
}
