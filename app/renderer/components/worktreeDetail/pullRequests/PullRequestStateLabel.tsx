import { describePullRequest } from "@/lib/pullRequest";
import { cn } from "@/lib/utils";
import type { PullRequest } from "@shared/schemas";
import { STATE_LABEL, TONE_FILL, TONE_TEXT } from "./pullRequestShared";

// The PR's state in its tone: as text in a row, or as a pill that
// stands on its own beside a heading.
export function PullRequestStateLabel({
  pr,
  pill = false,
}: {
  pr: PullRequest;
  pill?: boolean;
}) {
  const { Icon, tone } = describePullRequest(pr);
  const stateLabel =
    pr.isDraft && pr.state === "OPEN" ? "Draft" : STATE_LABEL[pr.state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap",
        pill
          ? cn(
              "gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium tracking-normal",
              TONE_FILL[tone],
            )
          : "gap-2 text-sm leading-snug",
        TONE_TEXT[tone],
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {stateLabel}
    </span>
  );
}
