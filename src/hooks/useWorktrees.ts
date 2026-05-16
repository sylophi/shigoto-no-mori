import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  clearScriptRunsForWorktree,
  scriptKey,
  scriptRuns,
} from "@/store/scriptRuns";
import type {
  CreateWorktreeResult,
  Project,
  ShigomoriConfig,
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
  return useMutation<CreateWorktreeResult, Error, CreateWorktreeInput>({
    mutationFn: (input) => window.api.worktrees.create(input),
    onSuccess: (result, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["worktrees", vars.projectId],
      });
      const { applied, failures } = result.carryOver;
      if (failures.length > 0) {
        const lines = failures.slice(0, 4).map((f) => `${f.path}: ${f.reason}`);
        const more = failures.length - lines.length;
        toast.warning(
          `Carried over ${applied} of ${applied + failures.length} entries`,
          {
            description:
              lines.join("\n") + (more > 0 ? `\n…and ${more} more` : ""),
          },
        );
      }
      // Kick off the project's setup script for the new worktree. Read
      // through the cache so we don't trigger an extra IPC roundtrip
      // when the configure page has already fetched the config.
      void queryClient
        .ensureQueryData<ShigomoriConfig | null>({
          queryKey: ["shigomori", vars.projectId],
          queryFn: () => window.api.shigomori.read(vars.projectId),
        })
        .then((config) => {
          const command = config?.scripts?.setup?.trim();
          if (!command) return;
          const key = scriptKey(vars.projectId, result.worktree.id, {
            kind: "setup",
          });
          return scriptRuns.start({
            key,
            worktreeId: result.worktree.id,
            slot: { kind: "setup" },
            runner: () =>
              window.api.scripts.run({
                projectId: vars.projectId,
                worktreeId: result.worktree.id,
                script: "setup",
              }),
          });
        })
        .catch((err) => {
          toast.warning("Setup didn't run", {
            description:
              err instanceof Error
                ? err.message
                : "See Scripts on the worktree",
          });
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
      clearScriptRunsForWorktree(vars.worktreeId);
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
    meta: { errorTitle: "Couldn't switch branch" },
  });
}
