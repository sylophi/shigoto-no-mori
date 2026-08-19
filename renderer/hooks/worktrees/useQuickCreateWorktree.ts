import { useNavigate } from "@tanstack/react-router";
import { notifyError } from "@/lib/toast";
import { useCreateWorktree } from "./useWorktreeMutations";

// "Quick create": a worktree off the project's default branch, no form,
// landing straight on the new worktree's page. Shared by the project
// row's + button and the inbox sidebar's New worktree menu so the two
// entry points can't drift on error handling.
export function useQuickCreateWorktree() {
  const navigate = useNavigate();
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
      defaultBranch = await window.api.projects.defaultBranch(projectId);
    } catch (err) {
      notifyError("Couldn't resolve default branch", err);
      return;
    }
    try {
      const { worktree } = await create.mutateAsync({
        projectId,
        base: defaultBranch,
      });
      void navigate({
        to: "/projects/$projectId/worktrees/$worktreeId",
        params: { projectId, worktreeId: worktree.id },
      });
    } catch {
      // The create mutation's meta already toasts this failure.
    }
  };

  const openCreateForm = (projectId: string) => {
    void navigate({ to: "/projects/$projectId/new", params: { projectId } });
  };

  return { quickCreate, openCreateForm, isPending: create.isPending };
}
