import { ChevronDown, CircleSlash, Layers2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { PullRequestStack } from "@shared/pullRequestStack";
import { cn } from "@/lib/utils";
import {
  MERGE_METHOD_LABEL,
  MERGE_METHOD_SHORT_LABEL,
} from "@/lib/pullRequest";
import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shared/schemas";
import { MergeStateIcon } from "./MergeStateIcon";
import { TONE_TEXT } from "./pullRequestShared";
import { useMergeBox } from "./useMergeBox";

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
    mergeStack,
    setDraft,
    armed,
    trigger,
    stackArmed,
    stackTrigger,
    stackOffer,
    stackDisabled,
    primary,
    activeMethod,
    mergeState,
    disabled,
    others,
    runMerge,
    runMergeStack,
    pickMethod,
    toggleDraft,
  } = useMergeBox({ worktree, pr, repoConfig, lastMergeMethod, stack });

  if (!primary || !activeMethod) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <CircleSlash aria-hidden className="size-3.5 shrink-0" />
        No merge methods are enabled for this repo.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-sm">
          <MergeStateIcon tone={mergeState.tone} />
          <span className={TONE_TEXT[mergeState.tone]}>{mergeState.label}</span>
        </span>
        <div className="inline-flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={
              setDraft.isPending || merge.isPending || mergeStack.isPending
            }
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
          {stackOffer && (
            <SimpleTooltip
              tip={
                stackOffer.blocked ??
                `${MERGE_METHOD_LABEL[activeMethod]}, ${stackOffer.count} pull requests from the bottom of the stack up to this one`
              }
            >
              <Button
                type="button"
                size="sm"
                variant={stackArmed ? "default" : "outline"}
                disabled={stackDisabled}
                onClick={() => stackTrigger(() => runMergeStack(activeMethod))}
              >
                {mergeStack.isPending ? (
                  <>
                    <Loader2 aria-hidden className="size-3.5 animate-spin" />
                    Merging stack…
                  </>
                ) : stackArmed ? (
                  "Click again to confirm"
                ) : (
                  <>
                    <Layers2 aria-hidden className="size-3.5" />
                    {stackOffer.whole
                      ? `Merge stack (${stackOffer.count})`
                      : `Merge up to here (${stackOffer.count})`}
                  </>
                )}
              </Button>
            </SimpleTooltip>
          )}
          <div className="inline-flex items-stretch">
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
                  Merging…
                </>
              ) : armed ? (
                "Click again to confirm"
              ) : (
                MERGE_METHOD_SHORT_LABEL[activeMethod]
              )}
            </Button>
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
      {merge.error && <ErrorBanner>{merge.error.message}</ErrorBanner>}
      {mergeStack.error && (
        <ErrorBanner>{mergeStack.error.message}</ErrorBanner>
      )}
      {setDraft.error && <ErrorBanner>{setDraft.error.message}</ErrorBanner>}
    </div>
  );
}
