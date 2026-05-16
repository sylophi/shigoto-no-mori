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
    // Local spinner inside the branch dropdown; the global indicator
    // would be misleading since branches are invisible until opened.
    meta: { errorTitle: "Couldn't list branches", silentSpinner: true },
  });
}

function invalidateBranchState(
  qc: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  void qc.invalidateQueries({ queryKey: ["branches", projectId] });
  void qc.invalidateQueries({ queryKey: ["worktrees", projectId] });
}

interface CreateBranchInput {
  projectId: string;
  name: string;
  base?: string;
}

export function useCreateBranch() {
  const qc = useQueryClient();
  return useMutation<void, Error, CreateBranchInput>({
    mutationFn: (input) => window.api.branches.create(input),
    onSuccess: (_data, vars) => invalidateBranchState(qc, vars.projectId),
    meta: { errorTitle: "Couldn't create branch" },
  });
}

interface RenameAnyBranchInput {
  projectId: string;
  oldName: string;
  newName: string;
}

export function useRenameAnyBranch() {
  const qc = useQueryClient();
  return useMutation<void, Error, RenameAnyBranchInput>({
    mutationFn: (input) => window.api.branches.rename(input),
    onSuccess: (_data, vars) => invalidateBranchState(qc, vars.projectId),
    meta: { errorTitle: "Couldn't rename branch" },
  });
}

interface DeleteBranchInput {
  projectId: string;
  name: string;
  force?: boolean;
}

export function useDeleteBranch() {
  const qc = useQueryClient();
  return useMutation<void, Error, DeleteBranchInput>({
    mutationFn: (input) => window.api.branches.delete(input),
    onSuccess: (_data, vars) => invalidateBranchState(qc, vars.projectId),
    // The page surfaces an inline force-delete prompt on the first
    // non-force failure; toast on top would be noise.
    meta: { silentError: true },
  });
}
