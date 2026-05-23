import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BranchList } from "@shared/schemas";

export function useBranches(projectId: string | null) {
  return useQuery<BranchList>({
    queryKey: ["branches", projectId],
    queryFn: () => {
      if (!projectId) return { local: [], remote: [] };
      return window.api.projects.listBranches(projectId);
    },
    enabled: projectId !== null,
    meta: { errorTitle: "Couldn't list branches" },
  });
}

// Anything derived from refs/heads or refs/remotes for a project: branches,
// worktrees (each carries ahead/behind + recent commits), and the resolved
// default branch (which depends on which refs exist). Branch and worktree
// mutations call this; the renderer also calls it when main broadcasts a
// background-fetch update.
export function invalidateBranchState(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  void queryClient.invalidateQueries({ queryKey: ["branches", projectId] });
  void queryClient.invalidateQueries({ queryKey: ["worktrees", projectId] });
  void queryClient.invalidateQueries({
    queryKey: ["defaultBranch", projectId],
  });
}

interface CreateBranchInput {
  projectId: string;
  name: string;
  base?: string;
}

export function useCreateBranch() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, CreateBranchInput>({
    mutationFn: (input) => window.api.branches.create(input),
    onSuccess: (_data, vars) =>
      invalidateBranchState(queryClient, vars.projectId),
    meta: { errorTitle: "Couldn't create branch" },
  });
}

interface RenameAnyBranchInput {
  projectId: string;
  oldName: string;
  newName: string;
}

export function useRenameAnyBranch() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, RenameAnyBranchInput>({
    mutationFn: (input) => window.api.branches.rename(input),
    onSuccess: (_data, vars) =>
      invalidateBranchState(queryClient, vars.projectId),
    meta: { errorTitle: "Couldn't rename branch" },
  });
}

interface DeleteBranchInput {
  projectId: string;
  name: string;
}

export function useDeleteBranch() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteBranchInput>({
    mutationFn: (input) => window.api.branches.delete(input),
    onSuccess: (_data, vars) =>
      invalidateBranchState(queryClient, vars.projectId),
    meta: { errorTitle: "Couldn't delete branch" },
  });
}
