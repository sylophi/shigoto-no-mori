// A PR's identity (PullRequestIdentityView), measured whether "last
// updated" fits beside the author's line.
import { useLayoutEffect, useRef, useState } from "react";
import { useNow } from "@shigomori/ui/hooks/useNow.ts";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { PullRequestDetail, Worktree } from "@shigomori/contracts/schemas";
import { PullRequestIdentityView } from "@shigomori/ui/views/worktreeDetail/pullRequests/PullRequestIdentityView.tsx";

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
      showUpdated={showUpdated}
      rowRef={containerRef}
      measurerRef={measurerRef}
      onOpenDiff={() => nav.toPrDiff(worktree.projectId, worktree.id)}
    />
  );
}
