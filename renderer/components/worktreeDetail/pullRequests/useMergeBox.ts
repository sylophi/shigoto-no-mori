import { useState } from "react";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useMergePullRequest } from "@/hooks/pullRequests/useMergePullRequest";
import { useMergePullRequestStack } from "@/hooks/pullRequests/useMergePullRequestStack";
import { useSetPullRequestDraft } from "@/hooks/pullRequests/useSetPullRequestDraft";
import {
  describeMergeState,
  MERGE_METHOD_SHORT_LABEL,
  resolveMergeMethod,
} from "@/lib/pullRequest";
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

// How far a stack merge reaches: the whole stack, or the bottom up to
// and including this PR. The same thing on the stack's top.
export type StackReach = "upTo" | "stack";

export const STACK_REACH_OPTIONS: readonly {
  value: StackReach;
  label: string;
  title: string;
}[] = [
  {
    value: "upTo",
    label: "Up to here",
    title: "Merge from the bottom of the stack up to this pull request",
  },
  {
    value: "stack",
    label: "Whole stack",
    title: "Merge every open pull request in the stack",
  },
];

// What the merge button lands. In a stack that is never this PR alone
// into the branch below it (a fold nobody wants from here, and one
// GitHub refuses on its own stacks): it is the open PRs from the
// bottom up to the reach, so the PR being asked for is the top of
// that set.
interface MergePlan {
  // The PR number the merge is asked for: this PR, or the top of the
  // reach in a stack.
  number: number;
  // How many PRs land.
  count: number;
  // Why the button is disabled, or null when it is live.
  blocked: string | null;
}

function planFor(
  stack: PullRequestStack | null,
  pr: PullRequestDetail,
  reach: StackReach,
): MergePlan {
  if (!stack) return { number: pr.number, count: 1, blocked: null };
  const target = reach === "stack" ? stack.entries.length - 1 : stack.index;
  const set = stackMergeSet(stack, target);
  if (set === null) {
    return {
      number: pr.number,
      count: target + 1,
      blocked: "A closed pull request sits in the stack",
    };
  }
  const draft = set.find((entry) => entry.pr.isDraft);
  return {
    number: stack.entries[target]!.pr.number,
    count: set.length,
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
  const mergeOne = useMergePullRequest();
  const mergeStack = useMergePullRequestStack();
  const setDraft = useSetPullRequestDraft();
  const { armed, trigger, reset } = useConfirmTwice(CONFIRM_QUICK_MS);
  const { primary, allowed } = resolveMergeMethod(repoConfig, lastMergeMethod);
  const mergeState = describeMergeState(pr.mergeState, pr.isDraft);
  // The dropdown swaps the active method; null means "stick with whatever
  // the repo + saved preference resolve to". Kept local so picking a
  // method on one worktree doesn't bleed into another.
  const [pickedMethod, setPickedMethod] = useState<MergeMethod | null>(null);
  // Up to here by default: landing more than the page you are on says
  // is the surprise to avoid. On the stack's top both reaches agree
  // and the toggle stays hidden.
  const [reach, setReach] = useState<StackReach>("upTo");

  const atTop = stack !== null && stack.index === stack.entries.length - 1;
  const showReach = stack !== null && !atTop;
  const plan = planFor(stack, pr, reach);
  const activeMethod =
    pickedMethod && allowed.includes(pickedMethod) ? pickedMethod : primary;
  // One mutation is ever in flight: the single merge outside a stack,
  // the stack merge inside one.
  const merge = stack ? mergeStack : mergeOne;
  const disabled =
    !mergeState.canMerge || plan.blocked !== null || merge.isPending;
  const others = allowed.filter((m) => m !== activeMethod);

  const runMerge = (method: MergeMethod) => {
    merge.mutate(
      {
        projectId: worktree.projectId,
        branch: worktree.branch,
        number: plan.number,
        method,
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
    blocked: plan.blocked,
    label: activeMethod
      ? mergeLabel(activeMethod, stack, reach, plan.count)
      : "",
    pendingLabel: stack && plan.count > 1 ? "Merging stack…" : "Merging…",
    reach,
    showReach,
    runMerge,
    pickMethod,
    pickReach,
    toggleDraft,
  };
}

// "Squash and merge", then what it reaches when that is more than
// this PR: "stack (3)" on the top or with the whole stack picked,
// "up to here (2)" below it. A count of one is this PR alone, which
// the method label already says.
function mergeLabel(
  method: MergeMethod,
  stack: PullRequestStack | null,
  reach: StackReach,
  count: number,
): string {
  const base = MERGE_METHOD_SHORT_LABEL[method];
  if (!stack || count < 2) return base;
  const atTop = stack.index === stack.entries.length - 1;
  return atTop || reach === "stack"
    ? `${base} stack (${count})`
    : `${base} up to here (${count})`;
}
