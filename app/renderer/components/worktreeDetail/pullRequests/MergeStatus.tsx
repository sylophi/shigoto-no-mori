import { Chip } from "@/components/ui/chip-button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { describeChecks, type MergeVerdict } from "@/lib/pullRequest";
import { cn } from "@/lib/utils";
import type { PullRequestDetail } from "@shared/schemas";
import { ChecksPopover } from "./ChecksPopover";
import { ChecksSummaryIcon } from "./ChecksSummaryIcon";
import { MergeStateIcon } from "./MergeStateIcon";
import { TONE_TEXT } from "./pullRequestShared";

// The merge box's one status (describeMergeVerdict): its words, with
// the checks' icon when the checks are what it speaks of, and the run
// list a click away (ChecksPopover). With no checks to list it is the
// words alone. One line. `compact` keeps the icon alone, its words in
// the tooltip, for a row with no room (MergeBox); the words carry
// data-status-label for that measuring.
export function MergeStatus({
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
      {verdict.by === "checks" && summary ? (
        <ChecksSummaryIcon tone={summary.tone} />
      ) : (
        <MergeStateIcon tone={verdict.tone} />
      )}
      {!compact && (
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
        <Chip
          aria-label={tip ?? undefined}
          className="max-w-full text-sm whitespace-nowrap"
        >
          {content}
        </Chip>
      </SimpleTooltip>
    );
  }
  return (
    <ChecksPopover pr={pr} tip={tip} className="text-sm">
      {content}
    </ChecksPopover>
  );
}
