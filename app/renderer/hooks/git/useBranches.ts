import {
  type MutationMeta,
  useMutation,
  useQuery,
  useQueryClient,
  skipToken,
} from "@tanstack/react-query";
import type { BranchList } from "@shared/schemas";
import type { QueryKeyRegistry } from "@/lib/queryKeys";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";

export function useBranches(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<BranchList>({
    queryKey: keys.branches(projectId),
    queryFn:
      projectId !== null
        ? () => api.projects.listBranches(projectId)
        : skipToken,
    meta: { errorTitle: "Couldn't list branches" },
  });
}

// Anything derived from refs/heads or refs/remotes for a project: branches,
// worktrees (each carries ahead/behind + recent commits), and the resolved
// default branch (which depends on which refs exist). Branch and worktree
// mutations call this, and so does a host's refsRefreshed broadcast
// (lib/hostWatch.ts) after a background fetch.
export function invalidateBranchState(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: QueryKeyRegistry,
  projectId: string,
) {
  void queryClient.invalidateQueries({
    queryKey: keys.branches(projectId),
  });
  void queryClient.invalidateQueries({
    queryKey: keys.worktrees(projectId),
  });
  void queryClient.invalidateQueries({
    queryKey: keys.defaultBranch(projectId),
  });
}

// The Manage Branches mutations (and the worktree branch ops in
// useWorktreeBranchOps) all share one shape: call the API, then
// refresh everything derived from refs via invalidateBranchState.
export function useBranchMutation<
  Input extends { projectId: string },
  Result = void,
>(
  mutationFn: (api: HostApi, input: Input) => Promise<Result>,
  meta: MutationMeta,
) {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- onSuccess delegates to invalidateBranchState which fans out to three invalidateQueries calls
  return useMutation<Result, Error, Input>({
    mutationFn: (input) => mutationFn(api, input),
    onSuccess: (_data, vars) =>
      invalidateBranchState(queryClient, keys, vars.projectId),
    meta,
  });
}

interface CreateBranchInput {
  projectId: string;
  name: string;
  base?: string;
}

export function useCreateBranch() {
  return useBranchMutation<CreateBranchInput>(
    (api, input) => api.branches.create(input),
    { errorTitle: "Couldn't create branch" },
  );
}

interface RenameAnyBranchInput {
  projectId: string;
  oldName: string;
  newName: string;
}

export function useRenameAnyBranch() {
  return useBranchMutation<RenameAnyBranchInput>(
    (api, input) => api.branches.rename(input),
    { errorTitle: "Couldn't rename branch" },
  );
}

interface DeleteBranchInput {
  projectId: string;
  name: string;
  force?: boolean;
}

export function useDeleteBranch() {
  // BranchRow's confirm modal swaps into a force-delete prompt on
  // failure, so a toast on top would be noise.
  return useBranchMutation<DeleteBranchInput>(
    (api, input) => api.branches.delete(input),
    { silentError: true },
  );
}
