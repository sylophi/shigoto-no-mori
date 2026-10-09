import {
  ChevronDown,
  UserRound,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import { Chip, ChipButton } from "@/components/ui/chip-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  describeReviews,
  type PullRequestTone,
  sortReviewersWorstFirst,
} from "@/lib/pullRequest";
import type { PullRequestDetail } from "@shigomori/contracts/schemas";
import { REVIEWER_STATE, TONE_TEXT } from "./pullRequestShared";

const SUMMARY_ICON: Partial<Record<PullRequestTone, typeof UserRound>> = {
  emerald: UserRoundCheck,
  rose: UserRoundX,
};

// The PR's reviews as one chip beside the checks, with who stands
// where in a popover. A required review nobody has been asked for has
// no list to show, so it reads as a plain chip. `compact` keeps the
// icon alone, its words in the tooltip and for screen readers only,
// for a row with no room (MergeBox). Words that show carry
// data-reviews-label for that measuring.
export function ReviewsPopoverView({
  pr,
  compact = false,
}: {
  pr: PullRequestDetail;
  compact?: boolean;
}) {
  // Absent from a host on an older build.
  if (!pr.reviews) return null;
  const { reviewers } = pr.reviews;
  const summary = describeReviews(pr.reviews);
  if (!summary) return null;
  const Icon = SUMMARY_ICON[summary.tone] ?? UserRound;
  const icon = (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", TONE_TEXT[summary.tone])}
    />
  );
  const words = compact ? (
    <span className="sr-only">{summary.label}</span>
  ) : (
    <span data-reviews-label>{summary.label}</span>
  );
  if (reviewers.length === 0) {
    return (
      <SimpleTooltip tip={compact ? summary.label : null}>
        <Chip className="text-muted-foreground/80">
          {icon}
          {words}
        </Chip>
      </SimpleTooltip>
    );
  }
  return (
    <Popover>
      <SimpleTooltip tip={compact ? summary.label : null}>
        <PopoverTrigger
          render={
            <ChipButton>
              {icon}
              {words}
              <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
            </ChipButton>
          }
        />
      </SimpleTooltip>
      <PopoverContent className="flex w-max max-w-[min(--spacing(72),var(--available-width))] min-w-40 flex-col overflow-hidden">
        <ul className="max-h-80 min-h-0 space-y-0.5 overflow-y-auto">
          {sortReviewersWorstFirst(reviewers).map(({ login, state }) => {
            const { Icon: StateIcon, tone, label } = REVIEWER_STATE[state];
            return (
              // A re-requested reviewer is listed twice: their review,
              // and the request for another.
              <li
                key={`${state}::${login}`}
                className="flex items-center gap-1.5 px-1.5 py-0.5 text-xs"
              >
                <StateIcon
                  aria-hidden
                  className={cn("size-3 shrink-0", TONE_TEXT[tone])}
                />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {login}
                </span>
                <span className="ml-2 shrink-0 text-muted-foreground">
                  {label}
                </span>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
