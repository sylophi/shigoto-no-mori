import { ChevronDown, CircleSlash, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorBanner } from "@/components/ui/error-banner";
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
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
  repoConfig: RepoMergeConfig | null;
  lastMergeMethod: MergeMethod | undefined;
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
    runMerge,
    pickMethod,
    toggleDraft,
  } = useMergeBox({ worktree, pr, repoConfig, lastMergeMethod });

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
      {setDraft.error && <ErrorBanner>{setDraft.error.message}</ErrorBanner>}
    </div>
  );
}
