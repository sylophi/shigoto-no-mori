// The worktree's own options (WorktreeOptionsView): auto-pull, and
// shelving for a managed worktree.
import type { ReactNode } from "react";
import {
  useSetAutoPull,
  useSetShelved,
} from "@/hooks/worktrees/useWorktreeMutations";
import {
  canSetAutoPull,
  isManagedWorktree,
  type Worktree,
} from "@shigomori/contracts/schemas";
import { WorktreeOptionsView } from "@shigomori/ui/views/worktreeDetail/WorktreeOptionsView.tsx";

export function WorktreeOptions({
  worktree,
  busy,
  children,
}: {
  worktree: Worktree;
  busy: boolean;
  children?: ReactNode;
}) {
  const setAutoPull = useSetAutoPull();
  const setShelved = useSetShelved();
  const target = { projectId: worktree.projectId, worktreeId: worktree.id };
  const canAutoPull = canSetAutoPull(worktree);
  return (
    <WorktreeOptionsView
      autoPull={{
        checked: worktree.autoPull,
        can: canAutoPull,
        disabled: !canAutoPull || busy || setAutoPull.isPending,
        onChange: (autoPull) => setAutoPull.mutate({ ...target, autoPull }),
      }}
      // The primary checkout is the project itself, never on a shelf.
      shelve={
        isManagedWorktree(worktree)
          ? {
              checked: worktree.shelved,
              disabled: busy || setShelved.isPending,
              onChange: (shelved) => setShelved.mutate({ ...target, shelved }),
            }
          : undefined
      }
    >
      {children}
    </WorktreeOptionsView>
  );
}
