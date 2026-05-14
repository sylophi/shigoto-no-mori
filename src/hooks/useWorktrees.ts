import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CommitSummary, Project, Worktree } from "@shared/schemas";

export function useWorktrees(projectId: string | null) {
  return useQuery<Worktree[]>({
    queryKey: ["worktrees", projectId],
    queryFn: () => {
      if (!projectId) return [];
      return window.api.worktrees.list(projectId);
    },
    enabled: projectId !== null,
    staleTime: 10_000,
  });
}

// One query per project, sharing the per-project cache key with useWorktrees.
// `enabled` toggles them all off when the consumer isn't visible (palette).
export function useAllProjectWorktrees(projects: Project[], enabled = true) {
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: ["worktrees", project.id],
      queryFn: () => window.api.worktrees.list(project.id),
      staleTime: 10_000,
      enabled,
    })),
  });
}

interface CreateWorktreeInput {
  projectId: string;
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
    },
  });
}

export function useCommitHistory(
  projectId: string,
  worktreeId: string,
  options: { enabled?: boolean; limit?: number } = {},
) {
  const limit = options.limit ?? 30;
  return useQuery<CommitSummary[]>({
    queryKey: ["commits", projectId, worktreeId, limit],
    queryFn: () =>
      window.api.worktrees.commitHistory({ projectId, worktreeId, limit }),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}
