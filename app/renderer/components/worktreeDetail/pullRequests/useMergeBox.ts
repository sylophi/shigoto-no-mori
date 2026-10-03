import { useState } from "react";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useDisablePullRequestAutoMerge } from "@/hooks/pullRequests/useDisablePullRequestAutoMerge";
import { useMergePullRequest } from "@/hooks/pullRequests/useMergePullRequest";
import { useSetPullRequestDraft } from "@/hooks/pullRequests/useSetPullRequestDraft";
import type { PullRequestStack } from "@shared/pullRequestStack";
import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shared/schemas";
import { mergeBoxState, type StackReach } from "./mergeBoxState";

export {
  type MergeBoxMode,
  STACK_REACH_OPTIONS,
  type StackReach,
} from "./mergeBoxState";

interface UseMergeBoxArgs {
  worktree: Worktree;
  pr: PullRequestDetail;
  repoConfig: RepoMergeConfig | null;
  lastMergeMethod: MergeMethod | undefined;
  stack: PullRequestStack | null;
}

// The merge box's state (mergeBoxState.ts) with the picks it is
// worked out from and the mutations its buttons run.
export function useMergeBox({
  worktree,
  pr,
  repoConfig,
  lastMergeMethod,
  stack,
}: UseMergeBoxArgs) {
  const merge = useMergePullRequest();
  const setDraft = useSetPullRequestDraft();
  const disableAutoMerge = useDisablePullRequestAutoMerge();
  const { armed, trigger, reset } = useConfirmTwice(CONFIRM_QUICK_MS);
  // The dropdown swaps the active method; null means "stick with whatever
  // the repo + saved preference resolve to". Kept local so picking a
  // method on one worktree doesn't bleed into another.
  const [pickedMethod, setPickedMethod] = useState<MergeMethod | null>(null);
  // Up to here by default: landing more than the page you are on says
  // is the surprise to avoid. On the stack's top both reaches agree,
  // so the toggle stays hidden and the reach reads as the whole stack.
  const [pickedReach, setReach] = useState<StackReach>("upTo");
  const { plan, ...state } = mergeBoxState({
    pr,
    repoConfig,
    lastMergeMethod,
    stack,
    pickedMethod,
    pickedReach,
    mergePending: merge.isPending,
  });

  const runMerge = (method: MergeMethod) => {
    merge.mutate(
      {
        projectId: worktree.projectId,
        branch: worktree.branch,
        number: plan.number,
        method,
        stack: stack !== null,
      },
      { onSuccess: () => reset() },
    );
  };

  // Picking from the dropdown only swaps which method the main button
  // would run; it must NOT merge directly, or the two-step confirm guard
  // would only apply to one of the three methods. Same for the reach.
  const pickMethod = (method: MergeMethod) => {
    if (armed) reset();
    setPickedMethod(method);
  };
  const pickReach = (next: StackReach) => {
    if (armed) reset();
    setReach(next);
  };

  const toggleDraft = () => {
    setDraft.mutate({
      projectId: worktree.projectId,
      branch: worktree.branch,
      number: pr.number,
      draft: !pr.isDraft,
    });
  };

  const runDisableAutoMerge = () => {
    disableAutoMerge.mutate({
      projectId: worktree.projectId,
      branch: worktree.branch,
      number: pr.number,
    });
  };

  return {
    merge,
    setDraft,
    disableAutoMerge,
    armed,
    trigger,
    ...state,
    runMerge,
    pickMethod,
    pickReach,
    toggleDraft,
    runDisableAutoMerge,
  };
}
