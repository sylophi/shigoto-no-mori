import { notifyError } from "@/lib/toast";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useCreateWorktree } from "./useWorktreeMutations";
import { useWorktreeNav } from "./useWorktreeNav";

// "Quick create": a worktree off the project's default branch, no form,
// landing straight on the new worktree's page. Shared by the project
// row's + button and the inbox sidebar's New worktree menu so the two
// entry points can't drift on error handling. Scope-aware end to end:
// under a peer's HostScopeProvider the create runs there and the
// landing page is the device twin.
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
  const quickCreate = async (projectId: string) => {
    if (create.isPending) return;
    let defaultBranch: string;
    try {
      defaultBranch = await api.projects.defaultBranch(projectId);
    } catch (err) {
      notifyError("Couldn't resolve default branch", err);
      return;
    }
    try {
      const { worktree } = await create.mutateAsync({
        projectId,
        base: defaultBranch,
      });
      toWorktree(projectId, worktree.id);
    } catch {
      // The create mutation's meta already toasts this failure.
    }
  };

  const openCreateForm = (projectId: string) => {
    toProjectPage("new", projectId);
  };

  // The click rule every create entry point shares: plain creates
  // outright, a modified click (shift, cmd, ctrl) opens the form to
  // pick a base.
  const createFrom = (event: React.MouseEvent, projectId: string) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
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
