// The merge box as drawn (MergeBox.tsx runs it): the merge verdict and
// the checks chip, then Convert to draft, the stack reach and the
// merge split button, and any error under them. What it shows comes
// from mergeBoxState.ts.
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
import { MERGE_METHOD_LABEL } from "@/lib/pullRequest";
import { cn } from "@/lib/utils";
import type { MergeMethod, PullRequestDetail } from "@shared/schemas";
import { ChecksPopover } from "./ChecksPopover";
import {
  type MergeBoxState,
  STACK_REACH_OPTIONS,
  type StackReach,
} from "./mergeBoxState";
import { MergeStateIcon } from "./MergeStateIcon";
import { TONE_TEXT } from "./pullRequestShared";

const noop = () => undefined;

export interface MergeBoxViewProps {
  pr: PullRequestDetail;
  state: Omit<MergeBoxState, "plan">;
  // The merge button waits for its second click.
  armed?: boolean;
  mergePending?: boolean;
  setDraftPending?: boolean;
  disablePending?: boolean;
  mergeError?: string;
  setDraftError?: string;
  disableError?: string;
  onMerge?: () => void;
  onPickMethod?: (method: MergeMethod) => void;
  onPickReach?: (reach: StackReach) => void;
  onToggleDraft?: () => void;
  onDisableAutoMerge?: () => void;
}

export function MergeBoxView({
  pr,
  state,
  armed = false,
  mergePending = false,
  setDraftPending = false,
  disablePending = false,
  mergeError,
  setDraftError,
  disableError,
  onMerge,
  onPickMethod,
  onPickReach = noop,
  onToggleDraft,
  onDisableAutoMerge,
}: MergeBoxViewProps) {
  const {
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
  } = state;

  // The merge verdict (or why there's no merge button) with the checks
  // chip beside it, whichever way the box renders.
  const statusLine = (
    <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-2">
      {primary && activeMethod ? (
        <span className="inline-flex items-center gap-2 text-sm">
          <MergeStateIcon tone={status.tone} />
          <span className={TONE_TEXT[status.tone]}>{status.label}</span>
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

  // Auto-merge is armed: GitHub merges the PR the moment its
  // requirements are met, so the one thing left to offer is calling
  // that off. Reversible, so no two-step confirm.
  const disableButton = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disablePending}
      onClick={onDisableAutoMerge}
    >
      {disablePending ? (
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
      onClick={onMerge}
      className={cn(others.length > 0 && "rounded-r-none border-r-0")}
    >
      {mergePending ? (
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
            disabled={setDraftPending || mergePending}
            onClick={onToggleDraft}
            className="text-muted-foreground hover:text-foreground"
          >
            {setDraftPending ? (
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
              onChange={onPickReach}
              options={STACK_REACH_OPTIONS}
              disabled={mergePending}
              aria-label="How far up the stack to merge"
              optionClassName="px-2 py-0.5 text-xs"
            />
          )}
          <div className="inline-flex items-stretch">
            {mode === "armed" ? (
              disableButton
            ) : blocked ? (
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
                      onClick={() => onPickMethod?.(method)}
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
      {mergeError !== undefined && (
        <ErrorBanner
          message={mergeError}
          title={
            mode === "arm"
              ? "Couldn't enable auto-merge"
              : "Couldn't merge the pull request"
          }
        />
      )}
      {disableError !== undefined && (
        <ErrorBanner
          message={disableError}
          title="Couldn't disable auto-merge"
        />
      )}
      {setDraftError !== undefined && (
        <ErrorBanner
          message={setDraftError}
          title="Couldn't change the draft state"
        />
      )}
    </div>
  );
}
