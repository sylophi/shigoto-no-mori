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

// Switch the repo root back onto the primary branch, fast-forwarding the
// local primary onto its remote tip so the root lands up to date rather
// than on a stale local copy. Used by the post-merge cleanup on the root.
export function useSwitchToPrimary() {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, SwitchToPrimaryInput>({
    mutationFn: (input) => window.api.worktrees.switchToPrimary(input),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktrees(vars.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.branches(vars.projectId),
      });
    },
    // The cleanup box renders its own inline ErrorBanner.
    meta: { silentError: true },
  });
}
