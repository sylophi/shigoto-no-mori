import { describePullRequest } from "@/lib/pullRequest";
import type { StackPosition } from "@shared/pullRequestStack";
import type { PullRequest } from "@shared/schemas";
import { StatusPill } from "./StatusPill";

interface PullRequestPillProps {
  // Resolved by the caller: the inbox builder already looked it up to
  // bucket the row, and the tree row reads it off the per-project map it
  // subscribes to anyway.
  pr: PullRequest | undefined;
  // The classic row is one line of chrome, so the icon carries the state
  // and the number lives in the tooltip. The inbox row has the width to
  // show "#142" outright, which is what you'd actually quote to someone.
  showNumber?: boolean;
  // Where the PR sits in its stack, when it is in one
  // (shared/pullRequestStack.ts): the pill then reads "2/3", bottom
  // counted first, the order the stack merges in.
  stack?: StackPosition | null;
}

export function PullRequestPill({
  pr,
  showNumber,
  stack,
}: PullRequestPillProps) {
  if (!pr) return null;
  const { Icon, tone, label } = describePullRequest(pr);
  const position = stack ? `${stack.index + 1}/${stack.size}` : null;
  const title = position
    ? `${label} #${pr.number}, ${position} in a stack`
    : `${label} #${pr.number}`;
  const text = [showNumber ? `#${pr.number}` : null, position]
    .filter(Boolean)
    .join(" ");
  return (
    <StatusPill icon={Icon} tone={tone} title={title} aria-label={title}>
      {text || undefined}
    </StatusPill>
  );
}
