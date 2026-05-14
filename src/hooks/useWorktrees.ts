import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Project, Worktree } from "@shared/schemas";

export function useWorktrees(projectId: string | null) {
  return useQuery<Worktree[]>({
    queryKey: ["worktrees", projectId],
    queryFn: () => {
      if (!projectId) return [];
      return window.api.worktrees.list(projectId);
    },
    enabled: projectId !== null,
    // Sidebar renders inline "Failed to list worktrees" + the project-
    // missing affordance handles the dominant ENOENT case.
    meta: { silentError: true },
  });
}

// One query per project, sharing the per-project cache key with useWorktrees.
// `enabled` toggles them all off when the consumer isn't visible (palette).
export function useAllProjectWorktrees(projects: Project[], enabled = true) {
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: ["worktrees", project.id],
      queryFn: () => window.api.worktrees.list(project.id),
      enabled,
      meta: { silentError: true },
    })),
  });
}

interface CreateWorktreeInput {
  projectId: string;
  worktreeName?: string;
  branchName?: string;
  base?: string;
  checkout?: boolean;
}

export function useCreateWorktree() {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, CreateWorktreeInput>({
    mutationFn: (input) => window.api.worktrees.create(input),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["worktrees", vars.projectId],
      });
    },
    meta: { errorTitle: "Couldn't create worktree" },
  });
}

interface DeleteWorktreeInput {
  projectId: string;
  worktreeId: string;
  force?: boolean;
}

export function useDeleteWorktree() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteWorktreeInput>({
    mutationFn: (input) => window.api.worktrees.delete(input),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["worktrees", vars.projectId],
      });
    },
    // The detail page swaps into a force-delete prompt on failure — a
    // toast on top would be noise.
    meta: { silentError: true },
  });
}

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
        queryKey: ["worktrees", vars.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["branches", vars.projectId],
      });
    },
    meta: { errorTitle: "Couldn't rename branch" },
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
        queryKey: ["worktrees", vars.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["branches", vars.projectId],
      });
    },
    meta: { errorTitle: "Couldn't switch branch" },
  });
}
