import { useQueryClient } from "@tanstack/react-query";
import type { Worktree } from "@shared/schemas";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";

// Lands on a just-added project's primary checkout, so every way in
// ends somewhere useful instead of wherever the app happened to be.
// ensureQueryData reuses a warm cache entry (e.g. the always-mounted
// sidebar already listed this project mid-bulk-add) over re-listing.
// Best-effort: if listing fails, the project is added either way.
// Both navs follow the scope, so a project added on a peer opens under
// that peer's device route.
export function useOpenAddedProject(): (projectId: string) => Promise<void> {
  const queryClient = useQueryClient();
  const scope = useHostScope();
  // Route choice made outside the try below: React Compiler can't
  // lower a conditional inside one, and bails out the whole component.
  const worktreeNav = useWorktreeNav();
  const projectNav = useProjectNav();
  return async (projectId) => {
    try {
      const worktrees = await queryClient.ensureQueryData(
        worktreesQueryOptions(projectId, scope),
      );
      openProject(worktreeNav, projectNav, projectId, worktrees);
    } catch {
      // Stay wherever we are. The add itself already succeeded.
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
