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
  branchName: string;
  base?: string;
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
