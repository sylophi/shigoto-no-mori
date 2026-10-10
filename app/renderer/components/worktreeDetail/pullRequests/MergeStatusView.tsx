import { Chip } from "@shigomori/ui/primitives/chip-button.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import {
  describeChecks,
  type MergeVerdict,
} from "@shigomori/ui/lib/pullRequest.ts";
import { cn } from "@shigomori/ui/lib/utils.ts";
import type { PullRequestDetail } from "@shigomori/contracts/schemas";
import { ChecksPopoverView } from "./ChecksPopoverView";
import { ChecksSummaryIconView } from "./ChecksSummaryIconView";
import { MergeStateIconView } from "./MergeStateIconView";
import { TONE_TEXT } from "./pullRequestShared";

// The merge box's one status (describeMergeVerdict): its words, with
// the checks' spinner while they run and its tone's mark otherwise,
// and the run list a click away (ChecksPopoverView). With no checks to
// list it is the words alone. One line. `compact` keeps the icon alone, its words in
// the tooltip and for screen readers only, for a row with no room
// (MergeBox). Words that show carry data-status-label for that
// measuring.
export function MergeStatusView({
  pr,
  verdict,
  compact,
}: {
  pr: PullRequestDetail;
  verdict: MergeVerdict;
  compact: boolean;
}) {
  const summary = describeChecks(pr.checks);
  const tip = compact ? verdict.label : null;
  const content = (
    <>
      {/* Running checks spin. Otherwise the mark takes the status's
          tone (a failing check GitHub doesn't require warns). */}
      {verdict.by === "checks" && summary?.tone === "amber" ? (
        <ChecksSummaryIconView tone="amber" />
      ) : (
        <MergeStateIconView tone={verdict.tone} />
      )}
      {compact ? (
        <span className="sr-only">{verdict.label}</span>
      ) : (
        <span
          data-status-label
          className={cn("min-w-0 truncate", TONE_TEXT[verdict.tone])}
        >
          {verdict.label}
        </span>
      )}
    </>
  );
  if (!summary) {
    return (
      <SimpleTooltip tip={tip}>
        <Chip className="max-w-full text-sm whitespace-nowrap">{content}</Chip>
      </SimpleTooltip>
    );
  }
  return (
    <ChecksPopoverView pr={pr} tip={tip} className="text-sm">
      {content}
    </ChecksPopoverView>
  );
}
