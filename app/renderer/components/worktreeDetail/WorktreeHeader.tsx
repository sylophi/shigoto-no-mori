// The worktree page's header (WorktreeHeaderView): the title the work
// goes by, or its branch alone when it has none.
import { useLayoutEffect, useRef, useState } from "react";
import { usePullRequestStack } from "@/hooks/pullRequests/usePullRequestStack";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import type {
  PullRequest,
  PullRequestDetail,
  Worktree,
} from "@shigomori/contracts/schemas";
import { BranchTitle } from "./branch/BranchTitle";
import { PullRequestStateLabelView } from "./pullRequests/PullRequestStateLabelView";
import { StackListView } from "./pullRequests/StackListView";
import { PullRequestTitleLinkView } from "./pullRequests/PullRequestTitleLinkView";
import { MERGE_VERB } from "./pullRequests/pullRequestShared";
import { WorktreeHeaderView } from "@shigomori/ui/views/worktreeDetail/WorktreeHeaderView.tsx";

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
  return (
    <WorktreeHeaderView
      title={title}
      pr={
        pr
          ? {
              titleLink: (
                <PullRequestTitleLinkView
                  pr={pr}
                  aria-label={`Open pull request #${pr.number} on GitHub`}
                  data-no-hit-area
                  className="shrink-0 font-normal text-muted-foreground/60"
                >
                  #{pr.number}
                </PullRequestTitleLinkView>
              ),
              stateLabel: <PullRequestStateLabelView pr={pr} pill />,
              base: pr.baseRefName,
              mergeVerb: MERGE_VERB[pr.state],
            }
          : undefined
      }
      branchTitle={<BranchTitle worktree={worktree} subtitle />}
      stack={
        stack
          ? {
              name: `Stack, ${stack.index + 1} of ${stack.entries.length}`,
              list: <StackListView worktree={worktree} stack={stack} />,
            }
          : undefined
      }
      diff={
        detail
          ? {
              changedFiles: detail.changedFiles,
              additions: detail.additions,
              deletions: detail.deletions,
              onClick: () => nav.toPrDiff(worktree.projectId, worktree.id),
            }
          : undefined
      }
      lineRef={lineRef}
      branchRef={branchRef}
      showBase={showBase}
    />
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
