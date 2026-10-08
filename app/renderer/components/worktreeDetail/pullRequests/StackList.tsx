// The stack the worktree's PR sits in, top of the stack first down to
// the branch it all lands on, the way the branches sit on each other.
// Each row is the PR: its state, title and number. Which worktree
// holds each layer, and where, is the sidebar's job, which draws the
// stack as a rail in the same order. Merged rows stay: a stack whose
// bottom landed is still that stack until the rest follows.
import { GitBranch } from "lucide-react";
import { describePullRequest } from "@/lib/pullRequest";
import { cn } from "@/lib/utils";
import type { PullRequestStack } from "@shared/pullRequestStack";
import type { Worktree } from "@shigomori/contracts/schemas";
import { PullRequestTitleLink } from "./PullRequestIdentity";
import { TONE_TEXT } from "./pullRequestShared";
import { SimpleTooltip } from "@/components/ui/tooltip";

export function StackList({
  worktree,
  stack,
}: {
  worktree: Worktree;
  stack: PullRequestStack;
}) {
  const size = stack.entries.length;
  return (
    <ol className="divide-y divide-border/60 rounded-md border border-border/60">
      {stack.entries.toReversed().map((entry, i) => {
        const position = size - i;
        const current = entry.branch === worktree.branch;
        const { Icon, tone, label } = describePullRequest(entry.pr);
        return (
          <li
            key={entry.pr.number}
            aria-current={current ? "true" : undefined}
            className={cn(
              "flex min-w-0 items-center gap-2.5 px-2 py-1.5 text-sm",
              current && "bg-accent/50",
            )}
          >
            <span className="tabular w-3 shrink-0 text-right text-2xs text-muted-foreground/60">
              {position}
            </span>
            <SimpleTooltip tip={label}>
              <Icon
                aria-label={label}
                className={cn("size-3.5 shrink-0", TONE_TEXT[tone])}
              />
            </SimpleTooltip>
            <SimpleTooltip whenTruncated tip={entry.pr.title}>
              <PullRequestTitleLink
                pr={entry.pr}
                className="min-w-0 truncate"
              />
            </SimpleTooltip>
            <span className="shrink-0 text-muted-foreground/60">
              #{entry.pr.number}
            </span>
          </li>
        );
      })}
      <li className="flex items-center gap-2.5 px-2 py-1.5 text-xs text-muted-foreground">
        <span className="w-3 shrink-0" />
        <GitBranch aria-hidden className="size-3.5 shrink-0" />
        lands on
        <span className="font-mono text-foreground/80">{stack.base}</span>
      </li>
    </ol>
  );
}
