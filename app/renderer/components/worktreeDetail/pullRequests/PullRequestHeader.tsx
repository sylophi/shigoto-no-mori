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
import { useNow } from "@/hooks/ui/useNow";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import type { PullRequest, PullRequestDetail, Worktree } from "@shared/schemas";
import { BranchTitle } from "../branch/BranchTitle";
import { DiffButton } from "../DiffButton";
import { PullRequestStateLabel } from "./PullRequestStateLabel";
import { StackList } from "./StackList";
import { MERGE_VERB, openPullRequest } from "./pullRequestShared";

// The worktree page's header while its PR names the work
// (useWorktreeTitle): what the PR is, so the page names it once. Its
// title, number and state, then one line with where it lands from which
// branch (still renamed and switched, from one menu), where it sits in
// a stack (its list in a popover), and its diff. That line never wraps:
// the base gives way first, then the branch. What the PR says and what
// to do about it follow under the header (PullRequestLead). The
// project map's slim PR draws all of it but the diff at once, so the
// header doesn't grow when the lookup answers.
export function PullRequestHeader({
  worktree,
  pr,
}: {
  worktree: Worktree;
  pr: PullRequest | PullRequestDetail;
}) {
  const nav = useWorktreeNav();
  const now = useNow();
  const { data: detail } = useWorktreePullRequest(
    worktree.projectId,
    worktree.branch,
  );
  const stack = usePullRequestStack(worktree.projectId, worktree.branch);
  const lineRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);
  const showBase = useBaseFits(lineRef, branchRef, worktree.branch);
  const stackName = stack
    ? `Stack, ${stack.index + 1} of ${stack.entries.length}`
    : undefined;
  // Who opened it and when it last moved, behind the state: it's
  // nearly always yours, so it doesn't earn a place on the line.
  const byline = detail
    ? `@${detail.authorLogin}, updated ${formatRelativeTime(new Date(detail.updatedAt).getTime(), now)}`
    : null;
  const numberLink = (
    <button
      type="button"
      onClick={() => openPullRequest(pr.url)}
      aria-label={`Open pull request #${pr.number} on GitHub`}
      data-no-hit-area
      className="rounded font-normal text-muted-foreground/60 transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
    >
      #{pr.number}
    </button>
  );
  const statePill = (
    <SimpleTooltip tip={byline}>
      <span className="inline-flex">
        <PullRequestStateLabel pr={pr} pill />
      </span>
    </SimpleTooltip>
  );
  return (
    <>
      {/* One line too: the title truncates beside its number, and the
          state keeps its place at the end. */}
      <div className="mb-1 flex min-w-0 items-center gap-3">
        <h1 className="flex min-w-0 items-baseline gap-1.5 text-2xl font-medium tracking-tight select-text">
          <SimpleTooltip whenTruncated tip={pr.title}>
            <span className="min-w-0 truncate">{pr.title}</span>
          </SimpleTooltip>
          <span className="shrink-0">{numberLink}</span>
        </h1>
        {/* At the row's end, where a status sits. */}
        <span className="ml-auto inline-flex shrink-0">{statePill}</span>
      </div>
      {/* One line however narrow. The base gives way first, and goes
          altogether before the branch would have to; then the branch.
          The stack and the diff keep their place. */}
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div
          ref={lineRef}
          className="flex min-w-0 grow items-center gap-1.5 text-sm text-muted-foreground"
        >
          {showBase && (
            <>
              <span className="min-w-6 shrink-[1000] truncate font-mono text-foreground/80">
                {pr.baseRefName}
              </span>
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
            className={cn("flex min-w-0 grow", showBase && "shrink-0")}
          >
            <BranchTitle worktree={worktree} subtitle menu />
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

// The least the base and its arrow take: a couple of letters, the
// arrow, and the gaps around it (min-w-6, size-3.5, gap-1.5 twice),
// and a pixel or two for widths that round.
const BASE_MIN = 24 + 14 + 6 * 2 + 2;

// Whether the base fits beside the branch with the branch shown in
// full. The branch's own width is read off its name (scrollWidth is
// the full text even while cut off) and controls, so hiding the base
// doesn't change the answer and the line never flips back and forth.
function useBaseFits(
  lineRef: React.RefObject<HTMLElement | null>,
  branchRef: React.RefObject<HTMLElement | null>,
  // Read again for a renamed branch, which resizes nothing observed.
  branchName: string,
): boolean {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const line = lineRef.current;
    const branch = branchRef.current;
    if (!line || !branch) return;
    const check = () => {
      // BranchTitle's row: the name, then its menu button. Absent while
      // the rename field stands in, and then the answer holds.
      const row = branch.firstElementChild;
      const name = row?.firstElementChild;
      if (!(row instanceof HTMLElement) || !(name instanceof HTMLElement)) {
        return;
      }
      const controls = row.scrollWidth - name.clientWidth;
      const needed = name.scrollWidth + controls;
      setFits(needed + BASE_MIN <= line.clientWidth);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(line);
    observer.observe(branch);
    return () => observer.disconnect();
  }, [lineRef, branchRef, branchName]);
  return fits;
}
