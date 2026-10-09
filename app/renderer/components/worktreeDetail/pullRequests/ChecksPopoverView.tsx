import { ChevronDown } from "lucide-react";
import { ChipButton } from "@/components/ui/chip-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  checksBreakdown,
  describeChecks,
  sortChecksWorstFirst,
} from "@/lib/pullRequest";
import { cn } from "@/lib/utils";
import type { PullRequestDetail } from "@shigomori/contracts/schemas";
import { CheckEntryView } from "./CheckEntryView";
import { ChecksSummaryIconView } from "./ChecksSummaryIconView";

// The PR's CI as one chip beside the merge state, with the run list in
// a popover so a long list never pushes the merge box down the page.
// `children` stands in for the chip's own words (MergeStatusView, which is
// the merge box's one status with the run list still a click away),
// and `tip` names the chip on hover when those leave out its words.
export function ChecksPopoverView({
  pr,
  children,
  tip = null,
  className,
}: {
  pr: PullRequestDetail;
  children?: React.ReactNode;
  tip?: string | null;
  className?: string;
}) {
  const summary = describeChecks(pr.checks);
  if (!summary) return null;
  return (
    <Popover>
      <SimpleTooltip tip={tip}>
        <PopoverTrigger
          render={
            <ChipButton
              className={cn("max-w-full whitespace-nowrap", className)}
            >
              {children ?? (
                <>
                  <ChecksSummaryIconView tone={summary.tone} />
                  {summary.label}
                </>
              )}
              <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
            </ChipButton>
          }
        />
      </SimpleTooltip>
      <PopoverContent className="flex w-max max-w-[min(--spacing(80),var(--available-width))] min-w-40 flex-col overflow-hidden">
        <p className="shrink-0 px-1.5 pt-1 pb-1.5 text-xs text-muted-foreground">
          {checksBreakdown(pr.checks)}
        </p>
        {/* The list scrolls, not the surface, so the breakdown stays
            pinned above it however little room the window leaves. */}
        <ul className="max-h-80 min-h-0 space-y-0.5 overflow-y-auto">
          {sortChecksWorstFirst(pr.checkList).map((check) => (
            <li key={`${check.name}::${check.url ?? ""}`}>
              <CheckEntryView check={check} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
