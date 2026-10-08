import { useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Layers2 } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { usePullRequestStack } from "@/hooks/pullRequests/usePullRequestStack";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { cn } from "@/lib/utils";
import type {
  PullRequest,
  PullRequestDetail,
  Worktree,
} from "@shigomori/contracts/schemas";
import { BranchTitle } from "./branch/BranchTitle";
import { DiffButton } from "./DiffButton";
import { PullRequestStateLabel } from "./pullRequests/PullRequestStateLabel";
import { StackList } from "./pullRequests/StackList";
import { PullRequestTitleLink } from "./pullRequests/PullRequestIdentity";
import { MERGE_VERB } from "./pullRequests/pullRequestShared";

// The worktree page's header: what the work is called (useWorktreeTitle),
// then one line with its branch (renamed and switched from one menu).
// Untitled work is called by its branch alone. While a PR names the
// work, the page names it once and the PR fills in the same two lines:
// its number and state beside the title, and on the branch's line
// where it lands, where it sits in a stack (its list in a popover),
// and its diff. That line never wraps: the base gives way first, then
// the branch. What the work is and what to do about its PR follow
// under the header. The project map's slim PR draws all of it but the
// diff at once, so the header doesn't grow when the lookup answers.
export function WorktreeHeader({
  worktree,
  title,
  pr,
}: {
  worktree: Worktree;
  title: string | null;
  pr: PullRequest | PullRequestDetail | null;
}) {
  if (title === null) return <BranchTitle worktree={worktree} />;
  return <TitledHeader worktree={worktree} title={title} pr={pr} />;
}

function TitledHeader({
  worktree,
  title,
  pr,
}: {
  worktree: Worktree;
  title: string;
  pr: PullRequest | PullRequestDetail | null;
}) {
  const nav = useWorktreeNav();
  const { data } = useWorktreePullRequest(worktree.projectId, worktree.branch, {
    enabled: pr !== null,
  });
  const projectStack = usePullRequestStack(worktree.projectId, worktree.branch);
  // Only the PR that names the work: a merged one the worktree has its
  // own title over keeps to its section further down.
  const detail = pr ? data : undefined;
  const stack = pr ? projectStack : null;
  const lineRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);
  const showBase = useBaseFits(lineRef, branchRef, worktree.branch);
  const stackName = stack
    ? `Stack, ${stack.index + 1} of ${stack.entries.length}`
    : undefined;
  return (
    <>
      {/* One line too: the title truncates beside its number, and the
          state keeps its place at the end. */}
      <div className="mb-1 flex min-w-0 items-center gap-3">
        <h1 className="flex min-w-0 items-baseline gap-1.5 text-2xl font-medium tracking-tight select-text">
          <SimpleTooltip whenTruncated tip={title}>
            <span className="min-w-0 truncate">{title}</span>
          </SimpleTooltip>
          {pr && (
            <PullRequestTitleLink
              pr={pr}
              aria-label={`Open pull request #${pr.number} on GitHub`}
              data-no-hit-area
              className="shrink-0 font-normal text-muted-foreground/60"
            >
              #{pr.number}
            </PullRequestTitleLink>
          )}
        </h1>
        {/* At the row's end, where a status sits. */}
        {pr && (
          <span className="ml-auto inline-flex shrink-0">
            <PullRequestStateLabel pr={pr} pill />
          </span>
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
              <SimpleTooltip whenTruncated tip={pr.baseRefName}>
                <span
                  data-pr-base
                  className="min-w-6 shrink-[1000] truncate font-mono text-foreground/80"
                >
                  {pr.baseRefName}
                </span>
              </SimpleTooltip>
              <ArrowLeft
                aria-label={MERGE_VERB[pr.state]}
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
            <BranchTitle worktree={worktree} subtitle />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {stack && (
            <Popover>
              <SimpleTooltip tip={stackName}>
                <PopoverTrigger
                  render={
                    <IconButton
                      aria-label={stackName}
                      className="data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
                    >
                      <Layers2 aria-hidden className="size-3.5" />
                    </IconButton>
                  }
                />
              </SimpleTooltip>
              <PopoverContent align="end" className="w-96 space-y-1.5">
                <p className="px-1.5 pt-1 text-xs text-muted-foreground">
                  {stackName}
                </p>
                <StackList worktree={worktree} stack={stack} />
              </PopoverContent>
            </Popover>
          )}
          {detail && detail.changedFiles > 0 && (
            <DiffButton
              changedFiles={detail.changedFiles}
              additions={detail.additions}
              deletions={detail.deletions}
              onClick={() => nav.toPrDiff(worktree.projectId, worktree.id)}
              words={false}
            />
          )}
        </div>
      </div>
    </>
  );
}

// Whether the base fits beside the branch with the branch shown in
// full. The branch's own width is read off its name (scrollWidth is
// the full text even while cut off) and controls, so hiding the base
// doesn't change the answer and the line never flips back and forth.
// The least the base takes (its min width, the arrow and the gaps) is
// read while it shows and kept for while it doesn't.
function useBaseFits(
  lineRef: React.RefObject<HTMLElement | null>,
  branchRef: React.RefObject<HTMLElement | null>,
  // Read again for a renamed branch, which resizes nothing observed.
  branchName: string,
): boolean {
  const [fits, setFits] = useState(true);
  const baseMin = useRef(0);
  useLayoutEffect(() => {
    const line = lineRef.current;
    const branch = branchRef.current;
    if (!line || !branch) return;
    const check = () => {
      const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
      const base = line.querySelector<HTMLElement>("[data-pr-base]");
      const arrow = base?.nextElementSibling;
      if (base && arrow instanceof Element) {
        baseMin.current =
          (parseFloat(getComputedStyle(base).minWidth) || 0) +
          arrow.getBoundingClientRect().width +
          gap * 2 +
          // Widths that round.
          2;
      }
      // BranchTitle's name and its menu button. Absent while the
      // rename field stands in, and then the answer holds.
      const name = branch.querySelector<HTMLElement>("[data-branch-name]");
      const row = name?.parentElement;
      if (!name || !row) return;
      const controls = row.scrollWidth - name.clientWidth;
      const needed = name.scrollWidth + controls;
      setFits(needed + baseMin.current <= line.clientWidth);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(line);
    observer.observe(branch);
    return () => observer.disconnect();
  }, [lineRef, branchRef, branchName]);
  return fits;
}
