import type { Worktree } from "@shigomori/contracts/schemas";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { worktreeListKey, worktreesAtom } from "@/hooks/worktrees/useWorktrees";
import { firstValueOf, useRegistry } from "@/lib/runtime/viewHooks";

// Lands on a just-added project's primary checkout, so every way in
// ends somewhere useful instead of wherever the app happened to be.
// It reads the project's worktrees view, which the always-mounted
// sidebar may already be streaming (mid-bulk-add). Best-effort: if
// listing fails, the project is added either way.
// Both navs follow the scope, so a project added on a peer opens under
// that peer's device route.
export function useOpenAddedProject(): (projectId: string) => Promise<void> {
  const registry = useRegistry();
  const scope = useHostScope();
  // Route choice made outside the try below: React Compiler can't
  // lower a conditional inside one, and bails out the whole component.
  const worktreeNav = useWorktreeNav();
  const projectNav = useProjectNav();
  return async (projectId) => {
    const worktrees = await firstValueOf(
      registry,
      worktreesAtom(worktreeListKey(scope.deviceId, projectId)),
    );
    // With none, stay wherever we are. The add itself already succeeded.
    if (worktrees !== undefined) {
      openProject(worktreeNav, projectNav, projectId, worktrees);
    }
  };
}

function openProject(
  worktreeNav: ReturnType<typeof useWorktreeNav>,
  projectNav: ReturnType<typeof useProjectNav>,
  projectId: string,
  worktrees: readonly Worktree[],
) {
  // A bare repo registers fine but has no primary checkout, so offer
  // worktree creation instead.
  const primary = worktrees.find((w) => w.isPrimary);
  if (primary) worktreeNav.toWorktree(projectId, primary.id);
  else projectNav.toProjectPage("new", projectId);
}
