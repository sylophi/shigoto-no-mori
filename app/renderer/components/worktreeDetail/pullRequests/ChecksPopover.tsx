import { ChevronDown } from "lucide-react";
import { Chip, ChipButton } from "@/components/ui/chip-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  checksBreakdown,
  describeChecks,
  type MergeVerdict,
  sortChecksWorstFirst,
} from "@/lib/pullRequest";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { PullRequestDetail } from "@shared/schemas";
import { CheckEntry } from "./CheckEntry";
import { ChecksSummaryIcon } from "./ChecksSummaryIcon";
import { MergeStateIcon } from "./MergeStateIcon";
import { TONE_TEXT } from "./pullRequestShared";

// The PR's CI as one chip beside the merge state, with the run list in
// a popover so a long list never pushes the merge box down the page.
// Given the merge `verdict` (describeMergeVerdict), the chip is the
// merge box's one status: its words, with the checks' icon when the
// checks are what it speaks of, and the run list still a click away.
// With no checks to list it is the verdict alone. One line. `compact`
// keeps the icon alone, its words in the tooltip, for a row with no
// room (MergeBox); the words carry data-status-label for that measuring.
export function ChecksPopover({
  pr,
  verdict,
  compact = false,
}: {
  pr: PullRequestDetail;
  verdict?: MergeVerdict;
  compact?: boolean;
}) {
  const summary = describeChecks(pr.checks);
  const content = verdict ? (
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
  ) : (
    summary && (
      <>
        <ChecksSummaryIcon tone={summary.tone} />
        {summary.label}
      </>
    )
  );
  const tip = compact && verdict ? verdict.label : null;
  if (!summary) {
    return verdict ? (
      <SimpleTooltip tip={tip}>
        <Chip
          aria-label={tip ?? undefined}
          className="max-w-full text-sm whitespace-nowrap"
        >
          {content}
        </Chip>
      </SimpleTooltip>
    ) : null;
  }
  return (
    <Popover>
      <SimpleTooltip tip={tip}>
        <PopoverTrigger
          render={
            <ChipButton
              aria-label={tip ?? undefined}
              className={cn(
                "max-w-full whitespace-nowrap",
                verdict && "text-sm",
              )}
            >
              {content}
              <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
            </ChipButton>
          }
        />
      </SimpleTooltip>
      <PopoverContent className="flex w-80 flex-col overflow-hidden">
        <p className="shrink-0 px-1.5 pt-1 pb-1.5 text-xs text-muted-foreground">
          {checksBreakdown(pr.checks)}
        </p>
        {/* The list scrolls, not the surface, so the breakdown stays
            pinned above it however little room the window leaves. */}
        <ul className="max-h-80 min-h-0 space-y-0.5 overflow-y-auto">
          {sortChecksWorstFirst(pr.checkList).map((check) => (
            <li key={`${check.name}::${check.url ?? ""}`}>
              <CheckEntry check={check} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
