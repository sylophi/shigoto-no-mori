// What the merge box shows, worked out from the PR, the repo's merge
// settings and the stack: the status line, which button, its label,
// the method menu and the stack reach. Pure, so the box can be drawn
// without the app (MergeBoxView), and useMergeBox.ts adds the
// mutations and the picks on top.
import {
  armsAutoMerge,
  autoMergeButtonLabel,
  describeArmedAutoMerge,
  describeMergeState,
  MERGE_METHOD_LABEL,
  type PullRequestTone,
  resolveMergeMethod,
} from "@/lib/pullRequest";
import { stackMergeSet, type PullRequestStack } from "@shared/pullRequestStack";
import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
} from "@shared/schemas";

// How far a stack merge reaches: the whole stack, or the bottom up to
// and including this PR. The same thing on the stack's top.
export type StackReach = "upTo" | "stack";

// What the main button does. Merge now. Arm auto-merge, for a PR
// waiting on its base branch's rules on a repo that allows it. Or,
// with auto-merge armed already (here or on github.com), call it off,
// since GitHub lands the PR on its own.
export type MergeBoxMode = "merge" | "arm" | "armed";

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
export interface MergePlan {
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
    number: stack.entries[target]?.pr.number ?? pr.number,
    count: set.length,
    blocked: draft
      ? draft.pr.number === pr.number
        ? "Draft"
        : `#${draft.pr.number} in the stack is a draft`
      : null,
  };
}

export interface MergeBoxState {
  primary: MergeMethod | null;
  activeMethod: MergeMethod | null;
  mode: MergeBoxMode;
  status: { label: string; tone: PullRequestTone };
  disabled: boolean;
  // The methods the menu beside the button offers.
  others: MergeMethod[];
  blocked: string | null;
  // The PR the merge runs on: this one, or the stack's top when the
  // reach takes the whole stack.
  mergeNumber: number;
  label: string;
  // More than this PR lands: the label says so, and the icon marks it.
  landsStack: boolean;
  pendingLabel: string;
  reach: StackReach;
  showReach: boolean;
}

export function mergeBoxState({
  pr,
  repoConfig,
  lastMergeMethod,
  stack,
  pickedMethod = null,
  pickedReach = "upTo",
  mergePending = false,
}: {
  pr: PullRequestDetail;
  repoConfig: RepoMergeConfig | null;
  lastMergeMethod: MergeMethod | undefined;
  stack: PullRequestStack | null;
  // The method picked from the menu, null to stick with whatever the
  // repo and the saved preference resolve to.
  pickedMethod?: MergeMethod | null;
  // Up to here by default: landing more than the page you are on says
  // is the surprise to avoid.
  pickedReach?: StackReach;
  mergePending?: boolean;
}): MergeBoxState {
  const { primary, allowed } = resolveMergeMethod(repoConfig, lastMergeMethod);
  const armedWith = pr.autoMerge;
  const mode: MergeBoxMode =
    armedWith !== null
      ? "armed"
      : armsAutoMerge(repoConfig, pr, stack !== null)
        ? "arm"
        : "merge";
  const mergeState = describeMergeState(
    pr.mergeState,
    pr.isDraft,
    mode === "arm",
  );
  const status =
    armedWith !== null ? describeArmedAutoMerge(armedWith) : mergeState;
  // On the stack's top both reaches agree, so the toggle stays hidden
  // and the reach reads as the whole stack.
  const atTop = stack !== null && stack.index === stack.entries.length - 1;
  // Armed, the box has no merge to reach with or pick a method for.
  const showReach = stack !== null && !atTop && mode !== "armed";
  const reach: StackReach = atTop ? "stack" : pickedReach;
  const plan = planFor(stack, pr, reach);
  const activeMethod =
    pickedMethod && allowed.includes(pickedMethod) ? pickedMethod : primary;
  const disabled =
    !mergeState.canMerge || plan.blocked !== null || mergePending;
  const others =
    mode === "armed" ? [] : allowed.filter((m) => m !== activeMethod);
  return {
    primary,
    activeMethod,
    mode,
    status,
    disabled,
    others,
    blocked: plan.blocked,
    mergeNumber: plan.number,
    label: activeMethod
      ? mode === "arm"
        ? autoMergeButtonLabel(activeMethod)
        : mergeLabel(activeMethod, reach, plan.count)
      : "",
    landsStack: plan.count > 1,
    pendingLabel:
      mode === "arm"
        ? "Enabling auto-merge…"
        : plan.count > 1
          ? "Merging stack…"
          : "Merging…",
    reach,
    showReach,
  };
}

// "Squash and merge", then what it reaches when that is more than
// this PR: "stack (3)" or "up to here (2)". A count of one is this PR
// alone, which the method label already says.
function mergeLabel(
  method: MergeMethod,
  reach: StackReach,
  count: number,
): string {
  const base = MERGE_METHOD_LABEL[method];
  if (count < 2) return base;
  return reach === "stack"
    ? `${base} stack (${count})`
    : `${base} up to here (${count})`;
}
