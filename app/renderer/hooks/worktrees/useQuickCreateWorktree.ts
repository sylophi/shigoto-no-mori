import { notifyError } from "@/lib/toast";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useCreateWorktree } from "./useWorktreeMutations";
import { useWorktreeNav } from "./useWorktreeNav";

// The rule every create entry point shares: a plain pick creates
// outright, a modified one (shift, cmd, ctrl) opens the form to pick a
// base.
export const wantsCreateForm = (event: {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}) => event.shiftKey || event.metaKey || event.ctrlKey;

// "Quick create": a worktree off the project's default branch, no form,
// landing straight on the new worktree's page. Shared by the project
// row's + button and the inbox sidebar's New worktree menu so the two
// entry points can't drift on error handling. Scope-aware end to end:
// under a peer's HostScopeProvider the create runs there and the
// landing page is that device's.
export function useQuickCreateWorktree() {
  const { api } = useHostScope();
  const { toWorktree } = useWorktreeNav();
  const { toProjectPage } = useProjectNav();
  const create = useCreateWorktree();

  // Two failure sources, attributed by scope rather than by inspecting
  // `create.isError` after the fact: that read is a render-time
  // snapshot the closure captured, not the mutation's state now, so it
  // both double-toasted create failures and latched true forever after
  // the first one, swallowing genuine defaultBranch errors.
  // `branchName` names the new branch (the palette's typed name). Left
  // out, the worktree's picked name names it. Resolves true once on the
  // new worktree's page, false when it failed (and toasted) or was
  // already under way.
  const quickCreate = async (
    projectId: string,
    branchName?: string,
  ): Promise<boolean> => {
    if (create.isPending) return false;
    let defaultBranch: string;
    try {
      defaultBranch = await api.projects.defaultBranch({ projectId });
    } catch (err) {
      notifyError("Couldn't resolve default branch", err);
      return false;
    }
    try {
      const { worktree } = await create.mutateAsync({
        projectId,
        branchName,
        base: defaultBranch,
      });
      toWorktree(projectId, worktree.id);
      return true;
    } catch {
      // The create mutation's meta already toasts this failure.
      return false;
    }
  };

  // On the device `onDevice` names (a route device id), else the
  // scope's.
  const openCreateForm = (projectId: string, onDevice?: string) => {
    toProjectPage("new", projectId, onDevice);
  };

  // The click rule every create entry point shares (wantsCreateForm).
  const createFrom = (event: React.MouseEvent, projectId: string) => {
    if (wantsCreateForm(event)) {
      openCreateForm(projectId);
    } else {
      void quickCreate(projectId);
    }
  };

  return {
    quickCreate,
    openCreateForm,
    createFrom,
    isPending: create.isPending,
  };
}
