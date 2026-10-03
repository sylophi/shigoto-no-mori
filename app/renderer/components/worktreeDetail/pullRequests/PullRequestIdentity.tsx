import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useLayoutEffect, useRef, useState } from "react";
import { useNow } from "@/hooks/ui/useNow";
import type { PullRequestDetail, Worktree } from "@shared/schemas";
import { PullRequestIdentityView } from "./PullRequestIdentityView";

// The PR's identity (PullRequestIdentityView), with the clock, the way
// to its diff, and the measuring: the view draws a hidden
// natural-width copy of the meta row, and if that doesn't fit, the
// visible copy drops the "last updated" clause.
export function PullRequestIdentity({
  worktree,
  pr,
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
}) {
  const nav = useWorktreeNav();
  const now = useNow();
  const containerRef = useRef<HTMLDivElement>(null);
  const measurerRef = useRef<HTMLDivElement>(null);
  const [showUpdated, setShowUpdated] = useState(true);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measurer = measurerRef.current;
    if (!container || !measurer) return;
    const check = () => {
      const fits = measurer.scrollWidth <= container.clientWidth;
      setShowUpdated((prev) => (prev === fits ? prev : fits));
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(container);
    observer.observe(measurer);
    return () => observer.disconnect();
  }, []);

  return (
    <PullRequestIdentityView
      pr={pr}
      now={now}
      updatedTitle={new Date(pr.updatedAt).toLocaleString()}
      showUpdated={showUpdated}
      containerRef={containerRef}
      measurerRef={measurerRef}
      onOpenDiff={() => nav.toPrDiff(worktree.projectId, worktree.id)}
    />
  );
}
