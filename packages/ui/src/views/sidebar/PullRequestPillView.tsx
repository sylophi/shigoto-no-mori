import { describePullRequest } from "../../lib/pullRequest.ts";
import type { StackPosition } from "@shigomori/contracts/pullRequestStack";
import type { PullRequest } from "@shigomori/contracts/schemas/index";
import { StatusPillView } from "./StatusPillView.tsx";

interface PullRequestPillProps {
  // Resolved by the caller: the inbox builder already looked it up to
  // bucket the row, and the tree row reads it off the per-project map it
  // subscribes to anyway.
  pr: PullRequest | undefined;
  // Where the PR sits in its stack, when it is in one
  // (contracts' pullRequestStack.ts): the pill then reads "#142 2/3",
  // bottom counted first, the order the stack merges in.
  stack?: StackPosition | null;
  // The row stands on a stack rail that shows every layer
  // (WorktreeRow), which already says the order: the position then
  // stays in the tooltip, and the title gets the room.
  hidePosition?: boolean;
}

export function PullRequestPillView({
  pr,
  stack,
  hidePosition,
}: PullRequestPillProps) {
  if (!pr) return null;
  const { Icon, tone, label } = describePullRequest(pr);
  const position = stack ? `${stack.index + 1}/${stack.size}` : null;
  const title = position
    ? `${label} #${pr.number}, ${position} in a stack`
    : `${label} #${pr.number}`;
  // The number shows outright, since it's what you'd quote to someone.
  const text =
    position && !hidePosition ? `#${pr.number} ${position}` : `#${pr.number}`;
  return (
    <StatusPillView icon={Icon} tone={tone} tip={title} aria-label={title}>
      {text}
    </StatusPillView>
  );
}
