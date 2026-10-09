import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, CircleSlash, Layers2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import type { PullRequestStack } from "@shared/pullRequestStack";
import { cn } from "@/lib/utils";
import { describeMergeVerdict, MERGE_METHOD_LABEL } from "@/lib/pullRequest";
import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shigomori/contracts/schemas";
import { ChecksPopover } from "./ChecksPopover";
import { MergeStatus } from "./MergeStatus";
import { ReviewsPopover } from "./ReviewsPopover";
import { STACK_REACH_OPTIONS, useMergeBox } from "./useMergeBox";

export function MergeBox({
  worktree,
  pr,
  repoConfig,
  lastMergeMethod,
  stack,
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
  repoConfig: RepoMergeConfig | null;
  lastMergeMethod: MergeMethod | undefined;
  stack: PullRequestStack | null;
}) {
  const {
    merge,
    setDraft,
    disableAutoMerge,
    armed,
    trigger,
    primary,
    activeMethod,
    mode,
    status,
    disabled,
    others,
    blocked,
    label,
    landsStack,
    pendingLabel,
    reach,
    showReach,
    runMerge,
    pickMethod,
    pickReach,
    toggleDraft,
    runDisableAutoMerge,
  } = useMergeBox({ worktree, pr, repoConfig, lastMergeMethod, stack });
  const canMerge = primary !== null && activeMethod !== null;
  // A peer that takes no commands from here gets the status alone.
  const { canCommand } = useCommandAccess();
  const rowRef = useRef<HTMLDivElement>(null);
  const verdict = describeMergeVerdict(pr, status, mode === "armed");
  // The reviews' words would only repeat a status that names them.
  const reviewsSaid = verdict.by === "reviews";
  const compact = useCompactChips(rowRef, reviewsSaid, canMerge && canCommand);

  // The merge box's one status (or why there's no merge button, with
  // the checks beside it), then the reviews. Items of the row they sit
  // in, so a chip that doesn't fit wraps beside the buttons rather than
  // onto a line of its own.
  const statusItems = (
    <>
      {canMerge ? (
        <MergeStatus pr={pr} verdict={verdict} compact={compact.status} />
      ) : (
        <>
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <CircleSlash aria-hidden className="size-3.5 shrink-0" />
            No merge methods are enabled for this repo.
          </p>
          <ChecksPopover pr={pr} />
        </>
      )}
      <ReviewsPopover pr={pr} compact={reviewsSaid || compact.reviews} />
    </>
  );

  if (!primary || !activeMethod || !canCommand) {
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
      disabled={disableAutoMerge.isPending}
      onClick={runDisableAutoMerge}
    >
      {disableAutoMerge.isPending ? (
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
      variant={armed ? "default" : "outline"}
      disabled={disabled}
      onClick={() => trigger(() => runMerge(activeMethod))}
      className={cn(others.length > 0 && "rounded-r-none border-r-0")}
    >
      {merge.isPending ? (
        <>
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          {pendingLabel}
        </>
      ) : armed ? (
        "Click again to confirm"
      ) : (
        <>
          {landsStack && <Layers2 aria-hidden className="size-3.5" />}
          {label}
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
            disabled={setDraft.isPending || merge.isPending}
            onClick={toggleDraft}
            className="text-muted-foreground hover:text-foreground"
          >
            {setDraft.isPending ? (
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
          {showReach && (
            <SegmentedControl
              value={reach}
              onChange={pickReach}
              options={STACK_REACH_OPTIONS}
              disabled={merge.isPending}
              aria-label="How far up the stack to merge"
              optionClassName="px-2 py-0.5 text-xs"
            />
          )}
          <div className="inline-flex items-stretch">
            {mode === "armed" ? (
              disableButton
            ) : (
              <SimpleTooltip tip={blocked}>{mergeButton}</SimpleTooltip>
            )}
            {others.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      aria-label="Choose merge method"
                      className="rounded-l-none px-1.5"
                    >
                      <ChevronDown aria-hidden className="size-3.5" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" sideOffset={4}>
                  {others.map((method) => (
                    <DropdownMenuItem
                      key={method}
                      onClick={() => pickMethod(method)}
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
      {merge.error && (
        <ErrorBanner
          message={merge.error.message}
          title={
            mode === "arm"
              ? "Couldn't enable auto-merge"
              : "Couldn't merge the pull request"
          }
        />
      )}
      {disableAutoMerge.error && (
        <ErrorBanner
          message={disableAutoMerge.error.message}
          title="Couldn't disable auto-merge"
        />
      )}
      {setDraft.error && (
        <ErrorBanner
          message={setDraft.error.message}
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
function useCompactChips(
  rowRef: React.RefObject<HTMLElement | null>,
  reviewsSaid: boolean,
  present: boolean,
): { reviews: boolean; status: boolean } {
  const [level, setLevel] = useState(0);
  const widths = useRef({ reviews: 0, status: 0 });
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const gapOf = (el: Element) =>
      parseFloat(getComputedStyle(el).columnGap) || 0;
    const check = () => {
      const label = (key: "reviews" | "status") =>
        row.querySelector<HTMLElement>(`[data-${key}-label]`);
      for (const key of ["reviews", "status"] as const) {
        const el = label(key);
        // The words and the chip's gap before them.
        if (el?.parentElement) {
          widths.current[key] = el.scrollWidth + gapOf(el.parentElement);
        }
      }
      const reviews = reviewsSaid ? 0 : widths.current.reviews;
      const status = widths.current.status;
      const items = [...row.children] as HTMLElement[];
      // The row's width as if every word showed.
      const full =
        items.reduce((sum, el) => sum + el.offsetWidth, 0) +
        gapOf(row) * (items.length - 1) +
        (label("reviews") ? 0 : reviews) +
        (label("status") ? 0 : status);
      const room = row.clientWidth;
      setLevel(full <= room ? 0 : full - reviews <= room ? 1 : 2);
    };
    const resize = new ResizeObserver(check);
    const watch = () => {
      resize.disconnect();
      resize.observe(row);
      for (const child of row.children) resize.observe(child);
      check();
    };
    watch();
    // A chip that swaps its element (the checks arriving) or its words
    // resizes nothing already watched, and nor does a font loading.
    const mutations = new MutationObserver(watch);
    mutations.observe(row, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    void document.fonts.ready.then(check);
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [rowRef, reviewsSaid, present]);
  return { reviews: level >= 1, status: level >= 2 };
}
