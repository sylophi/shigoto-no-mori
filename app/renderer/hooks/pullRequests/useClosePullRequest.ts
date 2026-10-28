import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PullRequestDetail } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  invalidatePullRequestsForProject,
  pullRequestMutationKey,
} from "../projects/useProjectPullRequests";

interface CloseVariables {
  projectId: string;
  branch: string;
  number: number;
  comment: string;
}

export function useClosePullRequest() {
  const qc = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<void, Error, CloseVariables>({
    mutationKey: pullRequestMutationKey(keys),
    mutationFn: ({ projectId, number, comment }) =>
      api.run(api.githubCli.closePullRequest({ projectId, number, comment })),
    // Written after, not ahead: a closed PR swaps the merge box (and the
    // dialog in it) for the cleanup one, which would take a failure's
    // banner with it.
    onSuccess: (_data, { projectId, branch }) => {
      const key = keys.worktreePullRequest(projectId, branch);
      const prev = qc.getQueryData<PullRequestDetail | null>(key);
      if (prev) qc.setQueryData(key, { ...prev, state: "CLOSED" as const });
    },
    onSettled: (_data, _err, { projectId }) => {
      invalidatePullRequestsForProject(qc, keys, projectId);
    },
    meta: { silentError: true },
  });
}
