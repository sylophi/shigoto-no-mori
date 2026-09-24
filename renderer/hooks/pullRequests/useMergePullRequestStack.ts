// Merge the PR and every open PR under it in its stack, as one action
// (githubCli.mergePullRequestStack). Same optimistic write and the
// same fan of invalidations as the single merge: the sidebar map, the
// per-branch detail, branch state and the saved merge method all move.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MergeMethod, PullRequestDetail } from "@shared/schemas";
import type { QueryKeyRegistry } from "@/lib/queryKeys";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { invalidateBranchState } from "../git/useBranches";
import { invalidatePullRequestsForProject } from "../projects/useProjectPullRequests";

interface MergeStackVariables {
  projectId: string;
  branch: string;
  number: number;
  method: MergeMethod;
}

type Context = {
  key: ReturnType<QueryKeyRegistry["worktreePullRequest"]>;
  prev: PullRequestDetail | null | undefined;
};

export function useMergePullRequestStack() {
  const qc = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<void, Error, MergeStackVariables, Context>({
    mutationFn: ({ projectId, number, method }) =>
      api.githubCli.mergePullRequestStack({ projectId, number, method }),
    onMutate: async ({ projectId, branch }) => {
      const key = keys.worktreePullRequest(projectId, branch);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<PullRequestDetail | null>(key);
      if (prev) {
        const next: PullRequestDetail = { ...prev, state: "MERGED" };
        qc.setQueryData<PullRequestDetail | null>(key, next);
      }
      return { key, prev };
    },
    onError: (_err, _vars, context) => {
      if (!context) return;
      qc.setQueryData(context.key, context.prev);
    },
    onSettled: (_data, _err, vars) => {
      invalidatePullRequestsForProject(qc, keys, vars.projectId);
      invalidateBranchState(qc, keys, vars.projectId);
      void qc.invalidateQueries({
        queryKey: keys.shigomoriConfig(vars.projectId),
      });
    },
    meta: { silentError: true },
  });
}
