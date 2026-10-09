// The worktree's own options (WorktreeOptionsView): auto-pull, and
// shelving for a managed worktree.
import type { ReactNode } from "react";
import {
  useSetAutoPull,
  useSetShelved,
} from "@/hooks/worktrees/useWorktreeMutations";
import { isManagedWorktree, type Worktree } from "@shigomori/contracts/schemas";
import { WorktreeOptionsView } from "./WorktreeOptionsView";

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
  // Once on, auto-pull stays switchable even if the upstream vanishes,
  // so it can be turned off again.
  const canAutoPull =
    worktree.autoPull || (worktree.hasUpstream && !worktree.detached);
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
