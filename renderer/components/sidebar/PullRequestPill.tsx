import { describePullRequest } from "@/lib/pullRequest";
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
}

export function PullRequestPill({ pr, showNumber }: PullRequestPillProps) {
  if (!pr) return null;
  const { Icon, tone, label } = describePullRequest(pr);
  return (
    <StatusPill
      icon={Icon}
      tone={tone}
      title={`${label} #${pr.number}`}
      aria-label={`${label} #${pr.number}`}
    >
      {showNumber ? `#${pr.number}` : undefined}
    </StatusPill>
  );
}
