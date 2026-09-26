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
import type { PullRequestStack } from "@shared/pullRequestStack";
import { cn } from "@/lib/utils";
import { MERGE_METHOD_LABEL } from "@/lib/pullRequest";
import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shared/schemas";
import { ChecksPopover } from "./ChecksPopover";
import { MergeStateIcon } from "./MergeStateIcon";
import { TONE_TEXT } from "./pullRequestShared";
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
    armed,
    trigger,
    primary,
    activeMethod,
    mergeState,
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
  } = useMergeBox({ worktree, pr, repoConfig, lastMergeMethod, stack });

  // The merge verdict (or why there's no merge button) with the checks
  // chip beside it, whichever way the box renders.
  const statusLine = (
    <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-2">
      {primary && activeMethod ? (
        <span className="inline-flex items-center gap-2 text-sm">
          <MergeStateIcon tone={mergeState.tone} />
          <span className={TONE_TEXT[mergeState.tone]}>{mergeState.label}</span>
        </span>
      ) : (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <CircleSlash aria-hidden className="size-3.5 shrink-0" />
          No merge methods are enabled for this repo.
        </p>
      )}
      <ChecksPopover pr={pr} />
    </div>
  );

  if (!primary || !activeMethod) return statusLine;

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        {statusLine}
        {/* Wraps on a narrow pane. The merge button and its method menu
            are one item, so they wrap together. */}
        <div className="inline-flex flex-wrap items-center gap-2">
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
            {blocked ? (
              <SimpleTooltip tip={blocked}>{mergeButton}</SimpleTooltip>
            ) : (
              mergeButton
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
          title="Couldn't merge the pull request"
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
