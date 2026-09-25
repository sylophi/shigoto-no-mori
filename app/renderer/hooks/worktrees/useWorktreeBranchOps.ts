import type { Worktree } from "@shared/schemas";
import { useBranchMutation } from "@/hooks/git/useBranches";

interface RenameBranchInput {
  projectId: string;
  worktreeId: string;
  newBranch: string;
}

export function useRenameBranch() {
  return useBranchMutation<RenameBranchInput, Worktree>(
    (api, input) => api.worktrees.renameBranch(input),
    // The inline rename input surfaces the error next to the field; a
    // global toast on top would be noise.
    { silentError: true },
  );
}

interface CheckoutBranchInput {
  projectId: string;
  worktreeId: string;
  branch: string;
}

export function useCheckoutBranch() {
  return useBranchMutation<CheckoutBranchInput, Worktree>(
    (api, input) => api.worktrees.checkoutBranch(input),
    // A toast, not the combobox: picking a branch closes the dropdown,
    // so an error shown inside it would never be seen.
    { errorTitle: "Couldn't switch branches" },
  );
}

interface SwitchToPrimaryInput {
  projectId: string;
  worktreeId: string;
}

// Post-merge cleanup on the repo root: switch it back onto the primary
// branch (fast-forwarding the local primary onto its remote tip) and delete
// the now-merged branch it was sitting on. This is a SINGLE main-side
// operation on purpose: the switch flips the root's branch to the primary,
// which unmounts the cleanup box, and React Query drops a `mutate()`
// callback once its component has unmounted, so chaining the delete in
// the renderer would silently lose it (which is exactly the bug this
// replaced).
// Errors surface via a global toast so they survive the box unmounting.
export function useSwitchToPrimaryAndDeleteBranch() {
  return useBranchMutation<SwitchToPrimaryInput, Worktree>(
    (api, input) => api.worktrees.switchToPrimaryAndDeleteBranch(input),
    { errorTitle: "Couldn't clean up the merged branch" },
  );
}
