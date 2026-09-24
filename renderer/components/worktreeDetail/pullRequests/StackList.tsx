// The stack the worktree's PR sits in, top of the stack first down to
// the branch it all lands on, the way the branches sit on each other.
// Each row is the PR: its state, title and number. Which worktree
// holds each layer, and where, is the sidebar's job, which draws the
// stack as a tree. Merged rows stay: a stack whose bottom landed is
// still that stack until the rest follows.
import { GitBranch } from "lucide-react";
import { describePullRequest } from "@/lib/pullRequest";
import { cn } from "@/lib/utils";
import type { PullRequestStack } from "@shared/pullRequestStack";
import type { Worktree } from "@shared/schemas";
import { openPullRequest, TONE_TEXT } from "./pullRequestShared";

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
            <Icon
              aria-label={label}
              className={cn("size-3.5 shrink-0", TONE_TEXT[tone])}
            />
            <button
              type="button"
              onClick={() => openPullRequest(entry.pr.url)}
              title={`Open #${entry.pr.number} on GitHub`}
              className="min-w-0 truncate rounded text-left transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            >
              {entry.pr.title}
            </button>
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
