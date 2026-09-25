import { ChevronDown } from "lucide-react";
import { ChipButton } from "@/components/ui/chip-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  checksBreakdown,
  describeChecks,
  sortChecksWorstFirst,
} from "@/lib/pullRequest";
import type { PullRequestDetail } from "@shared/schemas";
import { CheckEntry } from "./CheckEntry";
import { ChecksSummaryIcon } from "./ChecksSummaryIcon";

// The PR's CI as one chip beside the merge state, with the run list in
// a popover so a long list never pushes the merge box down the page.
export function ChecksPopover({ pr }: { pr: PullRequestDetail }) {
  const summary = describeChecks(pr.checks);
  if (!summary) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <ChipButton title="Show checks">
            <ChecksSummaryIcon tone={summary.tone} />
            {summary.label}
            <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
          </ChipButton>
        }
      />
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
