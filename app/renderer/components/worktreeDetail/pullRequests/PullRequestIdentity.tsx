import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useLayoutEffect, useRef, useState } from "react";
import { useNow } from "@/hooks/ui/useNow";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import type { PullRequest, PullRequestDetail, Worktree } from "@shared/schemas";
import { DiffButton } from "../DiffButton";
import { PullRequestStateLabel } from "./PullRequestStateLabel";
import { openPullRequest } from "./pullRequestShared";

// Title row carries the PR's identity: title + #num on the left, state
// pill on the right where the eye expects a status badge. The meta row
// below describes who's merging where and when it was last touched,
// with the diff button as the row's right-hand affordance. A hidden
// natural-width copy of the row measures whether the "last updated"
// trailing clause fits; if not, the visible copy drops it.
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

  const updatedDate = new Date(pr.updatedAt);
  const updatedTitle = updatedDate.toLocaleString();
  const updatedLabel = `, last updated ${formatRelativeTime(updatedDate.getTime(), now)}`;

  const openDiff = () => {
    nav.toPrDiff(worktree.projectId, worktree.id);
  };

  // The meta row's content, drawn twice: visible, and in the measurer.
  const metaRow = (trailing: string | null) => (
    <>
      <MetaSentence
        authorLogin={pr.authorLogin}
        baseRefName={pr.baseRefName}
        updatedTitle={updatedTitle}
        trailing={trailing}
      />
      {pr.changedFiles > 0 && (
        <DiffButton
          changedFiles={pr.changedFiles}
          additions={pr.additions}
          deletions={pr.deletions}
          onClick={openDiff}
        />
      )}
    </>
  );

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="min-w-0 flex-1 text-lg leading-snug font-medium select-text">
          <PullRequestTitleLink pr={pr} />{" "}
          <span className="font-normal text-muted-foreground/60">
            #{pr.number}
          </span>
        </h3>
        <PullRequestStateLabel pr={pr} />
      </div>
      <div
        ref={containerRef}
        className="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
      >
        {metaRow(showUpdated ? updatedLabel : null)}
        {/* inert keeps the natural-width measurer out of the tab order
            and the accessibility tree; pointer-events-none alone leaves
            the duplicated button focusable. The wrapper is pinned to the
            row's width and clips: a left-0 absolute nowrap box
            shrink-wraps to its full content width, so unclipped it widens
            the scroll pane's scrollable area (horizontal scrollbar). The
            observed inner div stays w-max so content-width changes (font
            swap, doubutsu weight remap) resize it and re-trigger
            measurement; its scrollWidth reports the full natural width. */}
        <div
          aria-hidden
          inert
          className="pointer-events-none invisible absolute inset-x-0 top-0 overflow-hidden"
        >
          <div
            ref={measurerRef}
            className="flex w-max items-center gap-x-3 whitespace-nowrap"
          >
            {metaRow(updatedLabel)}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetaSentence({
  authorLogin,
  baseRefName,
  updatedTitle,
  trailing,
}: {
  authorLogin: string;
  baseRefName: string;
  updatedTitle: string;
  trailing: string | null;
}) {
  return (
    <p
      className="text-xs text-muted-foreground select-text"
      title={updatedTitle}
    >
      <span className="text-foreground/80">@{authorLogin}</span> is merging into{" "}
      <span className="font-mono text-foreground/80">{baseRefName}</span>
      {trailing}
    </p>
  );
}

// The PR's title as the link to it on GitHub. Shared with the stack
// list, whose rows are the same link one per layer.
export function PullRequestTitleLink({
  pr,
  className,
}: {
  pr: PullRequest;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => openPullRequest(pr.url)}
      className={cn(
        "rounded text-left text-foreground transition-colors select-text hover:text-primary focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
      title={`Open #${pr.number} on GitHub`}
    >
      {pr.title}
    </button>
  );
}
