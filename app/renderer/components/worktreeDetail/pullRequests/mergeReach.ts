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
  tip: string;
}[] = [
  {
    value: "upTo",
    label: "Up to here",
    tip: "Merge from the bottom of the stack up to this pull request",
  },
  {
    value: "stack",
    label: "Whole stack",
    tip: "Merge every open pull request in the stack",
  },
];
