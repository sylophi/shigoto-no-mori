import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MergeMethod } from "@shared/schemas";
import { invalidateAllWorktreePullRequests } from "./useWorktreePullRequest";

interface MergeVariables {
  projectId: string;
  branch: string;
  number: number;
  method: MergeMethod;
}

// Performs `gh pr merge` and refreshes everything that the merge could
// have touched: the worktree PR query (status flips to MERGED), the
// worktree list (sync state recomputes once refs move), and the
// per-project ShigomoriConfig (main writes the new lastMergeMethod
// before returning).
export function useMergePullRequest() {
  const qc = useQueryClient();
  return useMutation<void, Error, MergeVariables>({
    mutationFn: (input) => window.api.githubCli.mergePullRequest(input),
    onSuccess: (_data, vars) => {
      invalidateAllWorktreePullRequests(qc);
      void qc.invalidateQueries({
        queryKey: ["worktrees", vars.projectId],
      });
      void qc.invalidateQueries({
        queryKey: ["shigomori", vars.projectId],
      });
    },
    // The section surfaces failures inline; a toast on top would be noise.
    meta: { silentError: true },
  });
}
