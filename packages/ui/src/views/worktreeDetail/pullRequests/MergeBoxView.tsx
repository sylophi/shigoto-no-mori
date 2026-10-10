import type { ReactNode, Ref } from "react";
import { ChevronDown, CircleSlash, Layers2, Loader2 } from "lucide-react";
import { Button } from "../../../primitives/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../primitives/dropdown-menu.tsx";
import { ErrorBanner } from "../../../primitives/error-banner.tsx";
import { SegmentedControl } from "../../../primitives/segmented-control.tsx";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";
import {
  type describeMergeVerdict,
  MERGE_METHOD_LABEL,
} from "../../../lib/pullRequest.ts";
import { cn } from "../../../lib/utils.ts";
import type {
  MergeMethod,
  PullRequestDetail,
} from "@shigomori/contracts/schemas/index";
import { ChecksPopoverView } from "./ChecksPopoverView.tsx";
import { MergeStatusView } from "./MergeStatusView.tsx";
import { ReviewsPopoverView } from "./ReviewsPopoverView.tsx";
import {
  type MergeBoxMode,
  STACK_REACH_OPTIONS,
  type StackReach,
} from "./mergeReach.ts";

// The box's merge controls, while there is a merge method and this
// device may command the worktree's host (MergeBox reads useMergeBox).
export interface MergeControls {
  // "arm" enables auto-merge, "armed" has it enabled.
  mode: MergeBoxMode;
  label: string;
  pendingLabel: string;
  // More than this PR lands.
  landsStack: boolean;
  // Why the merge waits, for its tooltip.
  blocked: string | null;
  disabled: boolean;
  pending: boolean;
  // The two-step confirm's first click landed.
  armed: boolean;
  onMerge: () => void;
  // The other merge methods, in the button's menu.
  others: readonly MergeMethod[];
  onPickMethod: (method: MergeMethod) => void;
  // How far up the stack to merge, when the PR sits in one.
  reach?: { value: StackReach; onPick: (reach: StackReach) => void };
  draftPending: boolean;
  onToggleDraft: () => void;
  disablePending: boolean;
  onDisableAutoMerge: () => void;
  error: string | undefined;
  disableError: string | undefined;
  draftError: string | undefined;
}

export function MergeBoxView({
  pr,
  hasMethod,
  verdict,
  compact,
  rowRef,
  merge,
}: {
  pr: PullRequestDetail;
  // The repo has a merge method enabled, without which the box says so.
  hasMethod: boolean;
  // The status the box leads with (describeMergeVerdict).
  verdict: ReturnType<typeof describeMergeVerdict>;
  // Which chips keep their icon alone (MergeBox measures the row).
  compact: { reviews: boolean; status: boolean };
  rowRef?: Ref<HTMLDivElement>;
  // Null without a merge method, or on a peer that takes no commands
  // from here: the status alone.
  merge: MergeControls | null;
}): ReactNode {
  const canMerge = hasMethod;
  // The reviews' words would only repeat a status that names them.
  const reviewsSaid = verdict.by === "reviews";
  const statusItems = (
    <>
      {canMerge ? (
        <MergeStatusView pr={pr} verdict={verdict} compact={compact.status} />
      ) : (
        <>
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <CircleSlash aria-hidden className="size-3.5 shrink-0" />
            No merge methods are enabled for this repo.
          </p>
          <ChecksPopoverView pr={pr} />
        </>
      )}
      <ReviewsPopoverView pr={pr} compact={reviewsSaid || compact.reviews} />
    </>
  );

  if (merge === null) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {statusItems}
      </div>
    );
  }

  // Auto-merge is armed: GitHub merges the PR the moment its
  // requirements are met, so the one thing left to offer is calling
  // that off. Reversible, so no two-step confirm.
  const disableButton = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={merge.disablePending}
      onClick={merge.onDisableAutoMerge}
    >
      {merge.disablePending ? (
        <>
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          Disabling…
        </>
      ) : (
        "Disable auto-merge"
      )}
    </Button>
  );

  const mergeButton = (
    <Button
      type="button"
      size="sm"
      variant={merge.armed ? "default" : "outline"}
      disabled={merge.disabled}
      onClick={merge.onMerge}
      className={cn(merge.others.length > 0 && "rounded-r-none border-r-0")}
    >
      {merge.pending ? (
        <>
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          {merge.pendingLabel}
        </>
      ) : merge.armed ? (
        "Click again to confirm"
      ) : (
        <>
          {merge.landsStack && <Layers2 aria-hidden className="size-3.5" />}
          {merge.label}
        </>
      )}
    </Button>
  );

  return (
    <div className="space-y-2">
      <div ref={rowRef} className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {statusItems}
        {/* Wraps on a narrow pane, staying at the row's end. The merge
            button and its method menu are one item, so they wrap
            together. */}
        <div className="ml-auto inline-flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={merge.draftPending || merge.pending}
            onClick={merge.onToggleDraft}
            className="text-muted-foreground hover:text-foreground"
          >
            {merge.draftPending ? (
              <>
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
                Updating…
              </>
            ) : pr.isDraft ? (
              "Mark as ready"
            ) : (
              "Convert to draft"
            )}
          </Button>
          {merge.reach && (
            <SegmentedControl
              value={merge.reach.value}
              onChange={merge.reach.onPick}
              options={STACK_REACH_OPTIONS}
              disabled={merge.pending}
              aria-label="How far up the stack to merge"
              optionClassName="px-2 py-0.5 text-xs"
            />
          )}
          <div className="inline-flex items-stretch">
            {merge.mode === "armed" ? (
              disableButton
            ) : (
              <SimpleTooltip tip={merge.blocked}>{mergeButton}</SimpleTooltip>
            )}
            {merge.others.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={merge.disabled}
                      aria-label="Choose merge method"
                      className="rounded-l-none px-1.5"
                    >
                      <ChevronDown aria-hidden className="size-3.5" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" sideOffset={4}>
                  {merge.others.map((method) => (
                    <DropdownMenuItem
                      key={method}
                      onClick={() => merge.onPickMethod(method)}
                    >
                      {MERGE_METHOD_LABEL[method]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>
      {merge.error !== undefined && (
        <ErrorBanner
          message={merge.error}
          title={
            merge.mode === "arm"
              ? "Couldn't enable auto-merge"
              : "Couldn't merge the pull request"
          }
        />
      )}
      {merge.disableError !== undefined && (
        <ErrorBanner
          message={merge.disableError}
          title="Couldn't disable auto-merge"
        />
      )}
      {merge.draftError !== undefined && (
        <ErrorBanner
          message={merge.draftError}
          title="Couldn't change the draft state"
        />
      )}
    </div>
  );
}

// Which chips keep their icon alone, their words in the tooltip: when
// the row can't hold everything on one line with them, the reviews'
// words go first, then the status's. Each one's width is kept from
// when it last showed, so the answer doesn't flip back and forth as
// the words come and go. `reviewsSaid`: the reviews show no words
// anyway (the status says them), so they make no room. `present`: the
// row is drawn (the box has a merge button), so there is one to watch.
