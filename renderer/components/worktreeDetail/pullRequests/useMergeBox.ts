import { useState } from "react";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useMergePullRequest } from "@/hooks/pullRequests/useMergePullRequest";
import { useSetPullRequestDraft } from "@/hooks/pullRequests/useSetPullRequestDraft";
import { describeMergeState, resolveMergeMethod } from "@/lib/pullRequest";
import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shared/schemas";

interface UseMergeBoxArgs {
  worktree: Worktree;
  pr: PullRequestDetail;
  repoConfig: RepoMergeConfig | null;
  lastMergeMethod: MergeMethod | undefined;
}

export function useMergeBox({
  worktree,
  pr,
  repoConfig,
  lastMergeMethod,
}: UseMergeBoxArgs) {
  const merge = useMergePullRequest();
  const setDraft = useSetPullRequestDraft();
  const { armed, trigger, reset } = useConfirmTwice(CONFIRM_QUICK_MS);
  const { primary, allowed } = resolveMergeMethod(repoConfig, lastMergeMethod);
  const mergeState = describeMergeState(pr.mergeState, pr.isDraft);
  // The dropdown swaps the active method; null means "stick with whatever
  // the repo + saved preference resolve to". Kept local so picking a
  // method on one worktree doesn't bleed into another.
  const [pickedMethod, setPickedMethod] = useState<MergeMethod | null>(null);

  const activeMethod =
    pickedMethod && allowed.includes(pickedMethod) ? pickedMethod : primary;
  const disabled = !mergeState.canMerge || merge.isPending;
  const others = allowed.filter((m) => m !== activeMethod);

  const runMerge = (method: MergeMethod) => {
    merge.mutate(
      {
        projectId: worktree.projectId,
        branch: worktree.branch,
        number: pr.number,
        method,
      },
      { onSuccess: () => reset() },
    );
  };

  // Picking from the dropdown only swaps which method the main button
  // would run; it must NOT merge directly, or the two-step confirm guard
  // would only apply to one of the three methods.
  const pickMethod = (method: MergeMethod) => {
    if (armed) reset();
    setPickedMethod(method);
  };

  const toggleDraft = () => {
    setDraft.mutate({
      projectId: worktree.projectId,
      branch: worktree.branch,
      number: pr.number,
      draft: !pr.isDraft,
    });
  };

  return {
    merge,
    setDraft,
    armed,
    trigger,
    primary,
    activeMethod,
    mergeState,
    disabled,
    others,
    runMerge,
    pickMethod,
    toggleDraft,
  };
}
