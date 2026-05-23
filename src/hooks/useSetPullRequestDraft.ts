import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateAllWorktreePullRequests } from "./useWorktreePullRequest";

interface SetDraftVariables {
  projectId: string;
  branch: string;
  number: number;
  draft: boolean;
}

export function useSetPullRequestDraft() {
  const qc = useQueryClient();
  return useMutation<void, Error, SetDraftVariables>({
    mutationFn: (input) => window.api.githubCli.setPullRequestDraft(input),
    onSuccess: () => {
      invalidateAllWorktreePullRequests(qc);
    },
    meta: { silentError: true },
  });
}
