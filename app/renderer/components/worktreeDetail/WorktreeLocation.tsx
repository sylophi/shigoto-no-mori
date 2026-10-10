// The worktree page's location (WorktreeLocationView), its rename sent
// to the device the worktree is on, and the page following the
// worktree to its new id.
import { useState } from "react";
import type { Worktree } from "@shigomori/contracts/schemas";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useRenameWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
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
  const nav = useWorktreeNav();
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
                  {
                    onSuccess: (renamed) => {
                      setEditing(false);
                      nav.toWorktree(renamed.projectId, renamed.id, true);
                    },
                  },
                ),
            }
      }
    />
  );
}
