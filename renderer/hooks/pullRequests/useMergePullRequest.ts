import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MergeMethod, PullRequestDetail } from "@shared/schemas";
import { invalidateBranchState } from "../git/useBranches";
import {
  invalidateAllWorktreePullRequests,
  worktreePullRequestKey,
} from "../worktrees/useWorktreePullRequest";

interface MergeVariables {
  projectId: string;
  // Branch isn't on the wire (gh identifies the PR by number) but the
  // hook keeps it so the optimistic cache write can find the right
  // query key.
  branch: string;
  number: number;
  method: MergeMethod;
}

type Context = {
  key: ReturnType<typeof worktreePullRequestKey>;
  prev: PullRequestDetail | null | undefined;
};

export function useMergePullRequest() {
  const qc = useQueryClient();
  return useMutation<void, Error, MergeVariables, Context>({
    mutationFn: ({ projectId, number, method }) =>
      window.api.githubCli.mergePullRequest({ projectId, number, method }),
    onMutate: async ({ projectId, branch }) => {
      const key = worktreePullRequestKey(projectId, branch);
      // Cancel in-flight refetches so they don't clobber the
      // optimistic value before the mutation lands.
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<PullRequestDetail | null>(key);
      if (prev) {
        qc.setQueryData<PullRequestDetail | null>(key, {
          ...prev,
          state: "MERGED",
        });
      }
      return { key, prev };
    },
    onError: (_err, _vars, context) => {
      if (!context) return;
      qc.setQueryData(context.key, context.prev);
    },
    onSettled: (_data, _err, vars) => {
      // A merge moves remote refs, may delete the head branch (auto-
      // delete), and rewrites the per-project ShigomoriConfig with the
      // new lastMergeMethod. Invalidate everything downstream so the
      // sidebar dot, sync pill, and merge button all catch up.
      invalidateAllWorktreePullRequests(qc);
      invalidateBranchState(qc, vars.projectId);
      void qc.invalidateQueries({
        queryKey: ["shigomori", vars.projectId],
      });
    },
    // The section surfaces failures inline; a toast on top would be noise.
    meta: { silentError: true },
  });
}
