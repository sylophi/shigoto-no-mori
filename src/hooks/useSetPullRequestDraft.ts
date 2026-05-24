import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PullRequestDetail } from "@shared/schemas";
import {
  invalidateAllWorktreePullRequests,
  worktreePullRequestKey,
} from "./useWorktreePullRequest";

interface SetDraftVariables {
  projectId: string;
  // Same pattern as MergeVariables: branch is for the optimistic write
  // only, not the IPC payload.
  branch: string;
  number: number;
  draft: boolean;
}

type Context = {
  key: ReturnType<typeof worktreePullRequestKey>;
  prev: PullRequestDetail | null | undefined;
};

export function useSetPullRequestDraft() {
  const qc = useQueryClient();
  return useMutation<void, Error, SetDraftVariables, Context>({
    mutationFn: ({ projectId, number, draft }) =>
      window.api.githubCli.setPullRequestDraft({ projectId, number, draft }),
    onMutate: async ({ projectId, branch, draft }) => {
      const key = worktreePullRequestKey(projectId, branch);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<PullRequestDetail | null>(key);
      if (prev) {
        qc.setQueryData<PullRequestDetail | null>(key, {
          ...prev,
          isDraft: draft,
          // gh recomputes mergeable state after the flip; we can't
          // predict it (depends on conflicts, checks, protections), so
          // mark it UNKNOWN until the refetch settles. The button
          // becomes inert for the brief window, which is honest.
          mergeState: draft ? "DRAFT" : "UNKNOWN",
        });
      }
      return { key, prev };
    },
    onError: (_err, _vars, context) => {
      if (!context) return;
      qc.setQueryData(context.key, context.prev);
    },
    onSettled: () => {
      invalidateAllWorktreePullRequests(qc);
    },
    meta: { silentError: true },
  });
}
