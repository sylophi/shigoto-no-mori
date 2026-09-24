import { useState } from "react";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useMergePullRequest } from "@/hooks/pullRequests/useMergePullRequest";
import { useMergePullRequestStack } from "@/hooks/pullRequests/useMergePullRequestStack";
import { useSetPullRequestDraft } from "@/hooks/pullRequests/useSetPullRequestDraft";
import { describeMergeState, resolveMergeMethod } from "@/lib/pullRequest";
import { stackMergeSet, type PullRequestStack } from "@shared/pullRequestStack";
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
  stack: PullRequestStack | null;
}

// The stack merge button's state. Null when there is nothing to offer
// beyond the single merge: no stack, or nothing open under this PR.
export interface StackMergeOffer {
  // How many PRs land, this one included.
  count: number;
  // True when this PR is the stack's top, so the merge lands the whole
  // stack.
  whole: boolean;
  // Why the button is disabled, or null when it is live.
  blocked: string | null;
}

function stackMergeOffer(
  stack: PullRequestStack | null,
  pr: PullRequestDetail,
): StackMergeOffer | null {
  if (!stack) return null;
  const set = stackMergeSet(stack, stack.index);
  const whole = stack.index === stack.entries.length - 1;
  if (set === null) {
    return {
      count: stack.index + 1,
      whole,
      blocked: "A closed pull request sits under this one",
    };
  }
  if (set.length < 2) return null;
  const draft = set.find((entry) => entry.pr.isDraft);
  return {
    count: set.length,
    whole,
    blocked: draft
      ? draft.pr.number === pr.number
        ? "Draft"
        : `#${draft.pr.number} in the stack is a draft`
      : null,
  };
}

export function useMergeBox({
  worktree,
  pr,
  repoConfig,
  lastMergeMethod,
  stack,
}: UseMergeBoxArgs) {
  const merge = useMergePullRequest();
  const mergeStack = useMergePullRequestStack();
  const setDraft = useSetPullRequestDraft();
  const { armed, trigger, reset } = useConfirmTwice(CONFIRM_QUICK_MS);
  const {
    armed: stackArmed,
    trigger: stackTrigger,
    reset: stackReset,
  } = useConfirmTwice(CONFIRM_QUICK_MS);
  const stackOffer = stackMergeOffer(stack, pr);
  const { primary, allowed } = resolveMergeMethod(repoConfig, lastMergeMethod);
  const mergeState = describeMergeState(pr.mergeState, pr.isDraft);
  // The dropdown swaps the active method; null means "stick with whatever
  // the repo + saved preference resolve to". Kept local so picking a
  // method on one worktree doesn't bleed into another.
  const [pickedMethod, setPickedMethod] = useState<MergeMethod | null>(null);

  const activeMethod =
    pickedMethod && allowed.includes(pickedMethod) ? pickedMethod : primary;
  const busy = merge.isPending || mergeStack.isPending;
  const disabled = !mergeState.canMerge || busy;
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

  // The stack lands with the same method the single button shows, so
  // picking a method from the dropdown applies to both.
  const runMergeStack = (method: MergeMethod) => {
    mergeStack.mutate(
      {
        projectId: worktree.projectId,
        branch: worktree.branch,
        number: pr.number,
        method,
      },
      { onSuccess: () => stackReset() },
    );
  };

  // Picking from the dropdown only swaps which method the main button
  // would run; it must NOT merge directly, or the two-step confirm guard
  // would only apply to one of the three methods.
  const pickMethod = (method: MergeMethod) => {
    if (armed) reset();
    if (stackArmed) stackReset();
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
    mergeStack,
    setDraft,
    armed,
    trigger,
    stackArmed,
    stackTrigger,
    stackOffer,
    stackDisabled: stackOffer === null || stackOffer.blocked !== null || busy,
    primary,
    activeMethod,
    mergeState,
    disabled,
    others,
    runMerge,
    runMergeStack,
    pickMethod,
    toggleDraft,
  };
}
