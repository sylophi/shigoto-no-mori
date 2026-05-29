import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { describeChecks } from "@/lib/pullRequest";
import type { PullRequestDetail } from "@shared/schemas";
import { CheckEntry } from "./CheckEntry";
import { ChecksSummaryIcon } from "./ChecksSummaryIcon";
import { TONE_TEXT } from "./pullRequestShared";

export function ChecksRow({ pr }: { pr: PullRequestDetail }) {
  const [expanded, setExpanded] = useState(false);
  const summary = describeChecks(pr.checks);
  if (!summary) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title="Toggle check details"
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChecksSummaryIcon tone={summary.tone} />
        <span className={cn("flex-1", TONE_TEXT[summary.tone])}>
          {summary.label}
        </span>
        {expanded ? (
          <ChevronDown
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/40"
          />
        ) : (
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/40"
          />
        )}
      </button>
      {expanded && (
        <ul className="space-y-0.5 pl-8">
          {pr.checkList.map((check) => (
            <li key={`${check.name}::${check.url ?? ""}`}>
              <CheckEntry check={check} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
