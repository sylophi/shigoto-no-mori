import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { pullRequestMutationKey } from "../projects/useProjectPullRequests";
import { optimisticPullRequestDetail } from "./optimisticPullRequestDetail";

interface DisableAutoMergeVariables {
  projectId: string;
  branch: string;
  number: number;
}

// Turns an armed auto-merge off, so the PR waits for a person again.
export function useDisablePullRequestAutoMerge() {
  const qc = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation({
    mutationKey: pullRequestMutationKey(keys),
    mutationFn: ({ projectId, number }: DisableAutoMergeVariables) =>
      api.githubCli.disablePullRequestAutoMerge({ projectId, number }),
    ...optimisticPullRequestDetail<DisableAutoMergeVariables>(
      qc,
      keys,
      (prev) => ({ ...prev, autoMerge: null }),
    ),
    // Only this PR's flag changed, and the sidebar's slim map doesn't
    // carry it, so the other pages' lookups aren't repeated.
    onSettled: (_data, _err, { projectId, branch }) => {
      void qc.invalidateQueries({
        queryKey: keys.worktreePullRequest(projectId, branch),
      });
    },
    meta: { silentError: true },
  });
}
