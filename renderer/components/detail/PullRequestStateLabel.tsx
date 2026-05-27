import { describePullRequest } from "@/lib/pullRequest";
import { cn } from "@/lib/utils";
import type { PullRequestDetail } from "@shared/schemas";
import { STATE_LABEL, TONE_TEXT } from "./pullRequestShared";

export function PullRequestStateLabel({ pr }: { pr: PullRequestDetail }) {
  const { Icon, tone, label } = describePullRequest(pr);
  const stateLabel =
    pr.isDraft && pr.state === "OPEN" ? "Draft" : STATE_LABEL[pr.state];
  return (
    <span
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-2 text-sm leading-snug whitespace-nowrap",
        TONE_TEXT[tone],
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {stateLabel}
    </span>
  );
}
