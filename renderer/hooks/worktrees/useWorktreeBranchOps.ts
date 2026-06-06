import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Worktree } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

interface RenameBranchInput {
  projectId: string;
  worktreeId: string;
  newBranch: string;
}

export function useRenameBranch() {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, RenameBranchInput>({
    mutationFn: (input) => window.api.worktrees.renameBranch(input),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktrees(vars.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.branches(vars.projectId),
      });
    },
    // The inline rename input surfaces the error next to the field; a
    // global toast on top would be noise.
    meta: { silentError: true },
  });
}

interface CheckoutBranchInput {
  projectId: string;
  worktreeId: string;
  branch: string;
}

export function useCheckoutBranch() {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, CheckoutBranchInput>({
    mutationFn: (input) => window.api.worktrees.checkoutBranch(input),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktrees(vars.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.branches(vars.projectId),
      });
    },
    // The branch combobox surfaces the error inline so the user can pick a
    // different branch without leaving the dropdown; toast would duplicate.
    meta: { silentError: true },
  });
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
// callback once its component has unmounted — so chaining the delete in the
// renderer would silently lose it (which is exactly the bug this replaced).
// Errors surface via a global toast so they survive the box unmounting.
export function useSwitchToPrimaryAndDeleteBranch() {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, SwitchToPrimaryInput>({
    mutationFn: (input) =>
      window.api.worktrees.switchToPrimaryAndDeleteBranch(input),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktrees(vars.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.branches(vars.projectId),
      });
    },
    meta: { errorTitle: "Couldn't clean up the merged branch" },
  });
}
