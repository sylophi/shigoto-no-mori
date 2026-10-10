import { SimpleTooltip } from "../../../primitives/tooltip.tsx";
import type { Ref } from "react";
import { formatRelativeTime } from "../../../lib/relativeTime.ts";
import type { PullRequestDetail } from "@shigomori/contracts/schemas/index";
import { DiffButtonView } from "../DiffButtonView.tsx";
import { PullRequestStateLabelView } from "./PullRequestStateLabelView.tsx";
import { MERGE_VERB } from "./pullRequestShared.ts";
import { PullRequestTitleLinkView } from "./PullRequestTitleLinkView.tsx";

// Title row carries the PR's identity: title + #num on the left, state
// pill on the right where the eye expects a status badge. The meta row
// below describes who's merging where and when it was last touched,
// with the diff button as the row's right-hand affordance. A hidden
// natural-width copy of the row measures whether the "last updated"
// trailing clause fits; if not, the visible copy drops it.
export function PullRequestIdentityView({
  pr,
  now,
  showUpdated,
  rowRef,
  measurerRef,
  onOpenDiff,
}: {
  pr: PullRequestDetail;
  // The moment "last updated" counts back from.
  now: number;
  // Whether "last updated" fits on the row (PullRequestIdentity
  // measures it on the hidden copy).
  showUpdated: boolean;
  rowRef?: Ref<HTMLDivElement>;
  measurerRef?: Ref<HTMLDivElement>;
  onOpenDiff: () => void;
}) {
  const updatedDate = new Date(pr.updatedAt);
  const updatedTip = updatedDate.toLocaleString();
  const updatedLabel = `, last updated ${formatRelativeTime(updatedDate.getTime(), now)}`;

  // The meta row's content, drawn twice: visible, and in the measurer.
  const metaRow = (trailing: string | null) => (
    <>
      <MetaSentence
        authorLogin={pr.authorLogin}
        verb={MERGE_VERB[pr.state]}
        baseRefName={pr.baseRefName}
        updatedTip={updatedTip}
        trailing={trailing}
      />
      {pr.changedFiles > 0 && (
        <DiffButtonView
          changedFiles={pr.changedFiles}
          additions={pr.additions}
          deletions={pr.deletions}
          onClick={onOpenDiff}
        />
      )}
    </>
  );

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="min-w-0 flex-1 text-lg leading-snug font-medium select-text">
          <PullRequestTitleLinkView pr={pr} />{" "}
          <span className="font-normal text-muted-foreground/60">
            #{pr.number}
          </span>
        </h3>
        <PullRequestStateLabelView pr={pr} />
      </div>
      <div
        ref={rowRef}
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
  verb,
  baseRefName,
  updatedTip,
  trailing,
}: {
  authorLogin: string;
  verb: string;
  baseRefName: string;
  updatedTip: string;
  trailing: string | null;
}) {
  return (
    <SimpleTooltip tip={updatedTip}>
      <p className="text-xs text-muted-foreground select-text">
        <span className="text-foreground/80">@{authorLogin}</span> {verb}{" "}
        <span className="font-mono text-foreground/80">{baseRefName}</span>
        {trailing}
      </p>
    </SimpleTooltip>
  );
}
