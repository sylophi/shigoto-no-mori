import {
  useIsMutating,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { clearScriptRunsForWorktree } from "@/store/scriptRuns";
import type {
  CreateWorktreeResult,
  DeleteWorktreeResult,
  Project,
  Worktree,
} from "@shared/schemas";

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
// Skip projects whose path is gone — git would just ENOENT.
export function useAllProjectWorktrees(projects: Project[], enabled = true) {
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: ["worktrees", project.id],
      queryFn: () => window.api.worktrees.list(project.id),
      enabled: enabled && project.pathExists !== false,
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
  return useMutation<CreateWorktreeResult, Error, CreateWorktreeInput>({
    mutationFn: (input) => window.api.worktrees.create(input),
    onSuccess: (_result, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["worktrees", vars.projectId],
      });
    },
    meta: { errorTitle: "Couldn't create worktree" },
  });
}

interface ConvertExternalWorktreeInput {
  projectId: string;
  worktreeId: string;
}

export function useConvertExternalWorktree() {
  const queryClient = useQueryClient();
  return useMutation<CreateWorktreeResult, Error, ConvertExternalWorktreeInput>(
    {
      mutationFn: (input) => window.api.worktrees.convertExternal(input),
      onSuccess: (_result, vars) => {
        void queryClient.invalidateQueries({
          queryKey: ["worktrees", vars.projectId],
        });
        // The old external worktree's id no longer maps to anything on disk
        // -- drop any cached script runs so they don't linger in the UI.
        clearScriptRunsForWorktree(vars.worktreeId);
      },
      // The page surfaces per-row errors inline; a toast on top would be noise.
      meta: { silentError: true },
    },
  );
}

interface RelocateWorktreeInput {
  projectId: string;
  worktreeId: string;
  destinationPath: string;
}

export function useRelocateWorktree() {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, RelocateWorktreeInput>({
    mutationFn: (input) => window.api.worktrees.relocate(input),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["worktrees", vars.projectId],
      });
      // The relocated worktree's id changes (it's derived from path), so
      // any cached script runs keyed by the pre-move id are stranded.
      clearScriptRunsForWorktree(vars.worktreeId);
    },
    // The page surfaces per-row errors inline; a toast on top would be noise.
    meta: { silentError: true },
  });
}

interface DeleteWorktreeInput {
  projectId: string;
  worktreeId: string;
  force?: boolean;
  skipCleanup?: boolean;
}

const DELETE_WORKTREE_MUTATION_KEY = ["delete-worktree"] as const;

export function useDeleteWorktree() {
  const queryClient = useQueryClient();
  return useMutation<DeleteWorktreeResult, Error, DeleteWorktreeInput>({
    mutationKey: DELETE_WORKTREE_MUTATION_KEY,
    mutationFn: (input) => window.api.worktrees.delete(input),
    onSuccess: (data, vars) => {
      // Only invalidate + clear runs when the worktree was actually
      // removed. Cleanup failures keep the worktree around for retry.
      if (data.ok) {
        // Drop the deleted entry from cache synchronously so consumers
        // routing off the back of this mutation (e.g. EmptyState's
        // first-worktree resolver) don't read the stale list during the
        // invalidate's background refetch.
        queryClient.setQueryData<Worktree[]>(
          ["worktrees", vars.projectId],
          (current) =>
            current ? current.filter((w) => w.id !== vars.worktreeId) : current,
        );
        void queryClient.invalidateQueries({
          queryKey: ["worktrees", vars.projectId],
        });
        clearScriptRunsForWorktree(vars.worktreeId);
      }
    },
    // The detail page swaps into a force-delete prompt on failure -- a
    // toast on top would be noise.
    meta: { silentError: true },
  });
}

export function useIsDeletingWorktree(worktreeId: string): boolean {
  return (
    useIsMutating({
      mutationKey: DELETE_WORKTREE_MUTATION_KEY,
      predicate: (m) =>
        (m.state.variables as DeleteWorktreeInput | undefined)?.worktreeId ===
        worktreeId,
    }) > 0
  );
}

interface SetShelvedInput {
  projectId: string;
  worktreeId: string;
  shelved: boolean;
}

export function useSetShelved() {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, SetShelvedInput>({
    mutationFn: (input) => window.api.worktrees.setShelved(input),
    onMutate: (vars) => {
      // Optimistic flip so the row's appearance and the sidebar group
      // both update before the IPC round-trip lands. The post-success
      // invalidate is the source of truth.
      queryClient.setQueryData<Worktree[]>(
        ["worktrees", vars.projectId],
        (current) =>
          current
            ? current.map((w) =>
                w.id === vars.worktreeId ? { ...w, shelved: vars.shelved } : w,
              )
            : current,
      );
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["worktrees", vars.projectId],
      });
    },
    meta: { errorTitle: "Couldn't update shelved state" },
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

export function useWorktreeDiff(
  projectId: string,
  worktreeId: string | undefined,
) {
  return useQuery<string>({
    queryKey: ["worktree-diff", projectId, worktreeId],
    queryFn: () => {
      if (!worktreeId) return "";
      return window.api.worktrees.diff({ projectId, worktreeId });
    },
    enabled: !!worktreeId,
    // Diff reflects working-tree state, which mutates outside our control;
    // always refetch on mount so re-entering the page shows current state.
    staleTime: 0,
    meta: { errorTitle: "Couldn't compute diff" },
  });
}

// Commit diffs are immutable once the commit exists, so we can cache them
// indefinitely. Keyed by hash so different commits don't share a slot.
export function useCommitDiff(
  projectId: string,
  worktreeId: string | undefined,
  hash: string,
) {
  return useQuery<string>({
    queryKey: ["commit-diff", projectId, worktreeId, hash],
    queryFn: () => {
      if (!worktreeId) return "";
      return window.api.worktrees.commitDiff({ projectId, worktreeId, hash });
    },
    enabled: !!worktreeId && hash.length > 0,
    staleTime: Infinity,
    meta: { errorTitle: "Couldn't compute diff" },
  });
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
    // The branch combobox surfaces the error inline so the user can pick a
    // different branch without leaving the dropdown; toast would duplicate.
    meta: { silentError: true },
  });
}

interface SyncWorktreeInput {
  projectId: string;
  worktreeId: string;
}

// Shared shape for the remote-sync family (push, pull, force-push,
// overwrite, publish, pull-and-push). Every one resolves to the
// refreshed Worktree and only differs in the API method + error title.
function useSyncMutation(
  apiMethod: (input: SyncWorktreeInput) => Promise<Worktree>,
  errorTitle: string,
) {
  const queryClient = useQueryClient();
  return useMutation<Worktree, Error, SyncWorktreeInput>({
    mutationFn: apiMethod,
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["worktrees", vars.projectId],
      });
    },
    meta: { errorTitle },
  });
}

export const usePushWorktree = () =>
  useSyncMutation((i) => window.api.worktrees.push(i), "Couldn't push");
export const usePullWorktree = () =>
  useSyncMutation((i) => window.api.worktrees.pull(i), "Couldn't pull");
export const usePushForceWorktree = () =>
  useSyncMutation(
    (i) => window.api.worktrees.pushForce(i),
    "Couldn't force-push",
  );
export const useOverwriteWorktree = () =>
  useSyncMutation(
    (i) => window.api.worktrees.overwrite(i),
    "Couldn't overwrite from upstream",
  );
export const usePublishWorktree = () =>
  useSyncMutation(
    (i) => window.api.worktrees.publish(i),
    "Couldn't publish branch",
  );
export const usePullAndPushWorktree = () =>
  useSyncMutation(
    (i) => window.api.worktrees.pullAndPush(i),
    "Couldn't pull and push",
  );
