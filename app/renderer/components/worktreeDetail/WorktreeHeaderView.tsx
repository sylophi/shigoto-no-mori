// The worktree page's header for work with a title of its own
// (WorktreeHeader binds it, and gives untitled work its branch alone):
// what the work is called (useWorktreeTitle), then one line with its
// branch (renamed and switched from one menu). While a PR names the
// work, the page names it once and the PR fills in the same two lines:
// its number and state beside the title, and on the branch's line
// where it lands, where it sits in a stack (its list in a popover),
// and its diff. That line never wraps: the base gives way first, then
// the branch. What the work is and what to do about its PR follow
// under the header. The project map's slim PR draws all of it but the
// diff at once, so the header doesn't grow when the lookup answers.
import type { ReactNode, Ref } from "react";
import { ArrowLeft, Layers2 } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DiffButtonView } from "./DiffButtonView";

export function WorktreeHeaderView({
  title,
  pr,
  branchTitle,
  stack,
  diff,
  lineRef,
  branchRef,
  showBase = true,
}: {
  title: string;
  // The PR that names the work: its number linked (PullRequestTitleLink),
  // its state (PullRequestStateLabel), and the base it lands on.
  pr?: {
    titleLink: ReactNode;
    stateLabel: ReactNode;
    base: string;
    mergeVerb: string;
  };
  // The branch's line (BranchTitle).
  branchTitle: ReactNode;
  // Where the PR sits in a stack, and the stack's list (StackList).
  stack?: { name: string; list: ReactNode };
  // The PR's diff, once its lookup answers.
  diff?: {
    changedFiles: number;
    additions: number;
    deletions: number;
    onClick: () => void;
  };
  // The branch's line, measured whether the base fits (WorktreeHeader).
  lineRef?: Ref<HTMLDivElement>;
  branchRef?: Ref<HTMLDivElement>;
  showBase?: boolean;
}) {
  return (
    <>
      {/* One line too: the title truncates beside its number, and the
          state keeps its place at the end. */}
      <div className="mb-1 flex min-w-0 items-center gap-3">
        <h1 className="flex min-w-0 items-baseline gap-1.5 text-2xl font-medium tracking-tight select-text">
          <SimpleTooltip whenTruncated tip={title}>
            <span className="min-w-0 truncate">{title}</span>
          </SimpleTooltip>
          {pr?.titleLink}
        </h1>
        {/* At the row's end, where a status sits. */}
        {pr && (
          <span className="ml-auto inline-flex shrink-0">{pr.stateLabel}</span>
        )}
      </div>
      {/* One line however narrow. The base gives way first, and goes
          altogether before the branch would have to; then the branch.
          The stack and the diff keep their place. */}
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div
          ref={lineRef}
          className="flex min-w-0 grow items-center gap-1.5 text-sm text-muted-foreground"
        >
          {pr && showBase && (
            <>
              <SimpleTooltip whenTruncated tip={pr.base}>
                <span
                  data-pr-base
                  className="min-w-6 shrink-[1000] truncate font-mono text-foreground/80"
                >
                  {pr.base}
                </span>
              </SimpleTooltip>
              <ArrowLeft
                aria-label={pr.mergeVerb}
                className="size-3.5 shrink-0 opacity-60"
              />
            </>
          )}
          {/* Room to the diff, so the rename field isn't squeezed to
              the name's width. Whole while the base shows: the base
              takes all the squeeze (a fraction of a pixel shared would
              cut the branch). */}
          <div
            ref={branchRef}
            className={cn("flex min-w-0 grow", pr && showBase && "shrink-0")}
          >
            {branchTitle}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {stack && (
            <Popover>
              <SimpleTooltip tip={stack.name}>
                <PopoverTrigger
                  render={
                    <IconButton
                      aria-label={stack.name}
                      className="data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
                    >
                      <Layers2 aria-hidden className="size-3.5" />
                    </IconButton>
                  }
                />
              </SimpleTooltip>
              <PopoverContent align="end" className="w-96 space-y-1.5">
                <p className="px-1.5 pt-1 text-xs text-muted-foreground">
                  {stack.name}
                </p>
                {stack.list}
              </PopoverContent>
            </Popover>
          )}
          {diff && diff.changedFiles > 0 && (
            <DiffButtonView {...diff} words={false} />
          )}
        </div>
      </div>
    </>
  );
}
