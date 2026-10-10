import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  MergeMethod,
  MergePullRequestResult,
  PullRequestDetail,
} from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { invalidateBranchState } from "../git/useBranches";
import {
  invalidatePullRequestsForProject,
  pullRequestMutationKey,
} from "../projects/useProjectPullRequests";

interface MergeVariables {
  projectId: string;
  // Branch isn't on the wire (gh identifies the PR by number) but the
  // hook keeps it so the cache write below can find the right query key.
  branch: string;
  number: number;
  method: MergeMethod;
  // The PR and every open PR under it in its stack, as one action.
  stack?: boolean;
}

export function useMergePullRequest() {
  const qc = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<MergePullRequestResult, Error, MergeVariables>({
    mutationKey: pullRequestMutationKey(keys),
    mutationFn: ({ projectId, number, method, stack }) =>
      api.githubCli.mergePullRequest({ projectId, number, method, stack }),
    // Write what the engine reported before the refetches below land, so
    // the box flips as the spinner stops: the PR merged, or auto-merge
    // is armed with the method. A PR a merge queue took reads as it
    // did until the queue lands it. Not written ahead of the result:
    // the same click merges or arms depending on GitHub's verdict at
    // that moment, so only the outcome says which.
    onSuccess: ({ outcome }, { projectId, branch, method }) => {
      if (outcome === "queued") return;
      const key = keys.worktreePullRequest(projectId, branch);
      const prev = qc.getQueryData<PullRequestDetail | null>(key);
      if (!prev) return;
      const next: PullRequestDetail =
        outcome === "merged"
          ? { ...prev, state: "MERGED" }
          : { ...prev, autoMerge: method };
      qc.setQueryData<PullRequestDetail | null>(key, next);
    },
    onSettled: (data, _err, { projectId, branch }) => {
      // The per-project ShigomoriConfig carries the new lastMergeMethod
      // whichever way the merge went.
      void qc.invalidateQueries({
        queryKey: keys.shigomoriConfig(projectId),
      });
      if (data?.outcome === "auto-merge") {
        // Nothing moved on the remote, and the sidebar's slim map
        // doesn't carry the flag: only this PR's page re-reads.
        void qc.invalidateQueries({
          queryKey: keys.worktreePullRequest(projectId, branch),
        });
        return;
      }
      // A merge moves remote refs and may delete the head branch
      // (auto-delete). Invalidate everything downstream so the sidebar
      // dot, sync pill, and merge button all catch up. A failure
      // re-reads the same, since gh may have merged before erroring.
      invalidatePullRequestsForProject(qc, keys, projectId);
      invalidateBranchState(qc, keys, projectId);
    },
    // The section surfaces failures inline; a toast on top would be noise.
    meta: { silentError: true },
  });
}
