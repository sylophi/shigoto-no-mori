import { useEffect } from "react";
import {
  type MutationMeta,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { BranchList } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export function useBranches(projectId: string | null) {
  return useQuery<BranchList>({
    queryKey: queryKeys.branches(projectId),
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
// mutations call this; useWatchGitRefs calls it when main broadcasts a
// background-fetch update.
export function invalidateBranchState(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.branches(projectId),
  });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.worktrees(projectId),
  });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.defaultBranch(projectId),
  });
}

// Re-run invalidateBranchState whenever main fetched refs for a project.
// Call once at the App root so a single subscription drives the whole
// renderer; the subscriber owns the lifecycle (unsubscribes on unmount).
export function useWatchGitRefs(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.api.git.onRefsRefreshed(({ projectId }) => {
        invalidateBranchState(queryClient, projectId);
      }),
    [queryClient],
  );
}

// The Manage Branches mutations all share one shape: call the API, then
// refresh everything derived from refs via invalidateBranchState.
function useBranchMutation<Input extends { projectId: string }>(
  mutationFn: (input: Input) => Promise<void>,
  meta: MutationMeta,
) {
  const queryClient = useQueryClient();
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- onSuccess delegates to invalidateBranchState which fans out to three invalidateQueries calls
  return useMutation<void, Error, Input>({
    mutationFn,
    onSuccess: (_data, vars) =>
      invalidateBranchState(queryClient, vars.projectId),
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
    (input) => window.api.branches.create(input),
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
    (input) => window.api.branches.rename(input),
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
  // failure -- a toast on top would be noise.
  return useBranchMutation<DeleteBranchInput>(
    (input) => window.api.branches.delete(input),
    { silentError: true },
  );
}
