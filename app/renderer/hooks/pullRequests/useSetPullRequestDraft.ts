import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  invalidatePullRequestsForProject,
  pullRequestMutationKey,
} from "../projects/useProjectPullRequests";
import { optimisticPullRequestDetail } from "./optimisticPullRequestDetail";

interface SetDraftVariables {
  projectId: string;
  branch: string;
  number: number;
  draft: boolean;
}

export function useSetPullRequestDraft() {
  const qc = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation({
    mutationKey: pullRequestMutationKey(keys),
    mutationFn: ({ projectId, number, draft }: SetDraftVariables) =>
      api.githubCli.setPullRequestDraft({ projectId, number, draft }),
    ...optimisticPullRequestDetail<SetDraftVariables>(
      qc,
      keys,
      (prev, { draft }) => ({
        ...prev,
        isDraft: draft,
        // gh recomputes mergeable state after the flip; we can't
        // predict it (depends on conflicts, checks, protections), so
        // mark it UNKNOWN until the refetch settles. The button
        // becomes inert for the brief window, which is honest.
        mergeState: draft ? "DRAFT" : "UNKNOWN",
      }),
    ),
    onSettled: (_data, _err, vars) => {
      invalidatePullRequestsForProject(qc, keys, vars.projectId);
    },
    meta: { silentError: true },
  });
}
