import {
  type MutationMeta,
  useMutation,
  useQuery,
  useQueryClient,
  skipToken,
} from "@tanstack/react-query";
import type { BranchList } from "@shigomori/contracts/schemas";
import type * as Effect from "effect/Effect";
import type { QueryKeyRegistry } from "@/lib/queryKeys";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { useRefreshTree } from "@/hooks/worktrees/useWorktreeChanges";

export function useBranches(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<BranchList>({
    queryKey: keys.branches(projectId),
    queryFn:
      projectId !== null
        ? ({ signal }) =>
            api.run(api.projects.listBranches({ projectId }), { signal })
        : skipToken,
    meta: { errorTitle: "Couldn't list branches" },
  });
}

// The requests derived from refs/heads or refs/remotes for a project:
// branches and the resolved default branch (which depends on which refs
// exist). The worktree list is the host's view, which re-reads when the
// refs move. Branch and worktree mutations call this, and so does a
// host's refsRefreshed broadcast (lib/hostWatch.ts) after a background
// fetch.
export function invalidateBranchState(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: QueryKeyRegistry,
  projectId: string,
) {
  void queryClient.invalidateQueries({
    queryKey: keys.branches(projectId),
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
  mutationFn: (api: HostApi, input: Input) => Effect.Effect<Result, unknown>,
  meta: MutationMeta,
) {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  const refreshTree = useRefreshTree();
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- onSuccess delegates to invalidateBranchState which fans out to three invalidateQueries calls
  return useMutation<Result, Error, Input>({
    mutationFn: (input) => api.run(mutationFn(api, input)),
    onSuccess: (_data, vars) => {
      invalidateBranchState(queryClient, keys, vars.projectId);
      // A checkout moves the worktree's tree, its history among it.
      if ("worktreeId" in vars && typeof vars.worktreeId === "string") {
        refreshTree({ projectId: vars.projectId, worktreeId: vars.worktreeId });
      }
    },
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
