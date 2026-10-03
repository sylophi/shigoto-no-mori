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
import type { MergeBoxViewProps } from "./MergeBoxView";

interface UseMergeBoxArgs {
  worktree: Worktree;
  pr: PullRequestDetail;
  repoConfig: RepoMergeConfig | null;
  lastMergeMethod: MergeMethod | undefined;
  stack: PullRequestStack | null;
}

// What the merge box draws (MergeBoxView): its state (mergeBoxState.ts)
// over the picks made here, and the mutations its buttons run.
export function useMergeBox({
  worktree,
  pr,
  repoConfig,
  lastMergeMethod,
  stack,
}: UseMergeBoxArgs): MergeBoxViewProps {
  const merge = useMergePullRequest();
  const setDraft = useSetPullRequestDraft();
  const disableAutoMerge = useDisablePullRequestAutoMerge();
  const { armed, trigger, reset } = useConfirmTwice(CONFIRM_QUICK_MS);
  // Kept local so picking a method on one worktree doesn't bleed into
  // another.
  const [pickedMethod, setPickedMethod] = useState<MergeMethod | null>(null);
  const [pickedReach, setReach] = useState<StackReach>("upTo");
  const state = mergeBoxState({
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
        number: state.mergeNumber,
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

  const { activeMethod } = state;
  return {
    pr,
    state,
    armed,
    mergePending: merge.isPending,
    setDraftPending: setDraft.isPending,
    disablePending: disableAutoMerge.isPending,
    mergeError: merge.error?.message,
    setDraftError: setDraft.error?.message,
    disableError: disableAutoMerge.error?.message,
    onMerge: () => {
      if (activeMethod) trigger(() => runMerge(activeMethod));
    },
    onPickMethod: pickMethod,
    onPickReach: pickReach,
    onToggleDraft: toggleDraft,
    onDisableAutoMerge: runDisableAutoMerge,
  };
}
