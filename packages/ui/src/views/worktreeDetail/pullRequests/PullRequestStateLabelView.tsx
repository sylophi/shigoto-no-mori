import { describePullRequest } from "../../../lib/pullRequest.ts";
import { cn } from "../../../lib/utils.ts";
import type { PullRequest } from "@shigomori/contracts/schemas/index";
import { STATE_LABEL } from "./pullRequestShared.ts";
import { TONE_MARK, TONE_FILL } from "../../../primitives/status-dot.tsx";

// The PR's state in its tone: as text in a row, or as a pill that
// stands on its own beside a heading.
export function PullRequestStateLabelView({
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
        TONE_MARK[tone],
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {stateLabel}
    </span>
  );
}
