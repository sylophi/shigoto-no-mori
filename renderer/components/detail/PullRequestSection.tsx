import { useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  ExternalLink,
  Loader2,
  MinusCircle,
  Trash2,
} from "lucide-react";
import { useIsFetching } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { DiffStats } from "@/components/ui/diff-stats";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SectionHeading } from "@/components/ui/section-heading";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useDelayedFlag } from "@/hooks/ui/useDelayedFlag";
import { useMergePullRequest } from "@/hooks/pullRequests/useMergePullRequest";
import { useRepoMergeConfig } from "@/hooks/githubCli/useRepoMergeConfig";
import { useSetPullRequestDraft } from "@/hooks/pullRequests/useSetPullRequestDraft";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useDeleteWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { formatRelativeTime } from "@/lib/relativeTime";
import { notifyError } from "@/lib/toast";
import {
  MERGE_METHOD_LABEL,
  MERGE_METHOD_SHORT_LABEL,
  describeChecks,
  describeMergeState,
  describePullRequest,
  resolveMergeMethod,
  type PullRequestTone,
} from "@/lib/pullRequest";
import type {
  MergeMethod,
  PullRequestCheck,
  PullRequestCheckBucket,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shared/schemas";

// Sub-second refetches would otherwise flash on/off too fast to read.
const REFRESH_INDICATOR_DELAY_MS = 250;

export function PullRequestSection({ worktree }: { worktree: Worktree }) {
  // Skip the PR query on detached HEAD — there's no branch to ask gh
  // about, and the eager enabled-flag spares the wasted IPC.
  const enabled = !worktree.detached;
  const { data: pr, isPending } = useWorktreePullRequest(
    worktree.projectId,
    worktree.branch,
    { enabled },
  );
  // Fire repo + shigomori queries in parallel with the PR query so the
  // merge box has its inputs ready as soon as the PR resolves.
  const { data: repoConfig } = useRepoMergeConfig(worktree.projectId);
  const { data: shigomori } = useShigomoriConfig(worktree.projectId);

  if (!enabled) return null;
  // While the initial query is in flight we still show the heading +
  // refresh indicator so the page doesn't pop content in late. Once
  // resolved with no PR, the section drops out entirely.
  if (!pr && !isPending) return null;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Pull request</SectionHeading>
        <PullRequestRefreshIndicator worktree={worktree} />
      </div>
      {pr && (
        <PullRequestBody
          worktree={worktree}
          pr={pr}
          repoConfig={repoConfig ?? null}
          lastMergeMethod={shigomori?.lastMergeMethod}
        />
      )}
    </section>
  );
}

function PullRequestRefreshIndicator({ worktree }: { worktree: Worktree }) {
  const fetching =
    useIsFetching({
      queryKey: queryKeys.worktreePullRequest(
        worktree.projectId,
        worktree.branch,
      ),
    }) > 0;
  const visible = useDelayedFlag(fetching, REFRESH_INDICATOR_DELAY_MS);
  if (!visible) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground/70 italic">
      <Loader2 aria-hidden className="size-3 animate-spin" />
      Refreshing…
    </span>
  );
}

function PullRequestBody({
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
  const isOpen = pr.state === "OPEN";
  const hasChecks = pr.checks.total > 0;

  return (
    <div className="space-y-4">
      <PullRequestIdentity worktree={worktree} pr={pr} />
      {isOpen && hasChecks && (
        <div className="-mx-2">
          <ChecksRow pr={pr} />
        </div>
      )}
      {isOpen && (
        <MergeBox
          worktree={worktree}
          pr={pr}
          repoConfig={repoConfig}
          lastMergeMethod={lastMergeMethod}
        />
      )}
      {!isOpen && !worktree.isPrimary && (
        <ClosedPullRequestBox worktree={worktree} />
      )}
    </div>
  );
}

// Title row carries the PR's identity: title + #num on the left, state
// pill on the right where the eye expects a status badge. The meta row
// below describes who's merging where and when it was last touched,
// with the diff button as the row's right-hand affordance. A hidden
// natural-width copy of the row measures whether the "last updated"
// trailing clause fits; if not, the visible copy drops it.
function PullRequestIdentity({
  worktree,
  pr,
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
}) {
  const navigate = useNavigate();
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
  const updatedLabel = `, last updated ${formatRelativeTime(updatedDate.getTime())}`;

  const openDiff = () => {
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId/pr-diff",
      params: { projectId: worktree.projectId, worktreeId: worktree.id },
    });
  };

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
        <MetaSentence
          authorLogin={pr.authorLogin}
          baseRefName={pr.baseRefName}
          updatedTitle={updatedTitle}
          trailing={showUpdated ? updatedLabel : null}
        />
        {pr.changedFiles > 0 && (
          <DiffButton
            changedFiles={pr.changedFiles}
            additions={pr.additions}
            deletions={pr.deletions}
            onClick={openDiff}
          />
        )}
        {/* inert keeps the natural-width measurer out of the tab order
            and the accessibility tree; pointer-events-none alone leaves
            the duplicated button focusable. */}
        <div
          ref={measurerRef}
          aria-hidden
          inert
          className="pointer-events-none invisible absolute top-0 left-0 flex items-center gap-x-3 whitespace-nowrap"
        >
          <MetaSentence
            authorLogin={pr.authorLogin}
            baseRefName={pr.baseRefName}
            updatedTitle={updatedTitle}
            trailing={updatedLabel}
          />
          {pr.changedFiles > 0 && (
            <DiffButton
              changedFiles={pr.changedFiles}
              additions={pr.additions}
              deletions={pr.deletions}
              onClick={openDiff}
            />
          )}
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

function DiffButton({
  changedFiles,
  additions,
  deletions,
  onClick,
}: {
  changedFiles: number;
  additions: number;
  deletions: number;
  onClick: () => void;
}) {
  const fileNoun = changedFiles === 1 ? "file" : "files";
  return (
    <button
      type="button"
      onClick={onClick}
      title="View pull request diff"
      className="tabular inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span>
        {changedFiles} {fileNoun} changed,
      </span>
      <DiffStats additions={additions} deletions={deletions} />
      <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-60" />
    </button>
  );
}

function PullRequestTitleLink({ pr }: { pr: PullRequestDetail }) {
  return (
    <a
      href={pr.url}
      onClick={(e) => {
        e.preventDefault();
        openPullRequest(pr.url);
      }}
      className="rounded text-foreground transition-colors select-text hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
      title={`Open #${pr.number} on GitHub`}
    >
      {pr.title}
    </a>
  );
}

function PullRequestStateLabel({ pr }: { pr: PullRequestDetail }) {
  const { Icon, tone, label } = describePullRequest(pr);
  const stateLabel =
    pr.isDraft && pr.state === "OPEN" ? "Draft" : STATE_LABEL[pr.state];
  return (
    <span
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-2 text-sm leading-snug whitespace-nowrap",
        TONE_TEXT[tone],
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {stateLabel}
    </span>
  );
}

function ChecksRow({ pr }: { pr: PullRequestDetail }) {
  const [expanded, setExpanded] = useState(false);
  const summary = describeChecks(pr.checks);
  if (!summary) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title="Toggle check details"
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChecksSummaryIcon tone={summary.tone} />
        <span className={cn("flex-1", TONE_TEXT[summary.tone])}>
          {summary.label}
        </span>
        {expanded ? (
          <ChevronDown
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/40"
          />
        ) : (
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/40"
          />
        )}
      </button>
      {expanded && (
        <ul className="space-y-0.5 pl-8">
          {pr.checkList.map((check, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- check names aren't unique across providers
            <li key={`${check.name}::${i}`}>
              <CheckEntry check={check} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CheckEntry({ check }: { check: PullRequestCheck }) {
  const { Icon, tone } = CHECK_BUCKET_ICON[check.bucket];
  const isPending = check.bucket === "pending";
  const Body = (
    <>
      <Icon
        aria-hidden
        className={cn(
          "size-3 shrink-0",
          TONE_TEXT[tone],
          isPending && "animate-spin",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">
        {check.name}
      </span>
      {check.url && (
        <ExternalLink
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover/check:opacity-100"
        />
      )}
    </>
  );
  if (!check.url) {
    return (
      <div className="flex items-center gap-1.5 px-1.5 py-0.5 text-xs">
        {Body}
      </div>
    );
  }
  const url = check.url;
  return (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        window.api.shell
          .openExternal(url)
          .catch((err) => notifyError("Couldn't open check", err));
      }}
      className="group/check flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      {Body}
    </a>
  );
}

function MergeBox({
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
  const merge = useMergePullRequest();
  const setDraft = useSetPullRequestDraft();
  const { armed, trigger, reset } = useConfirmTwice(CONFIRM_QUICK_MS);
  const { primary, allowed } = resolveMergeMethod(repoConfig, lastMergeMethod);
  const mergeState = describeMergeState(pr.mergeState, pr.isDraft);
  // The dropdown swaps the active method; null means "stick with whatever
  // the repo + saved preference resolve to". Kept local so picking a
  // method on one worktree doesn't bleed into another.
  const [pickedMethod, setPickedMethod] = useState<MergeMethod | null>(null);

  if (!primary) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <CircleSlash aria-hidden className="size-3.5 shrink-0" />
        No merge methods are enabled for this repo.
      </p>
    );
  }

  const activeMethod =
    pickedMethod && allowed.includes(pickedMethod) ? pickedMethod : primary;
  const disabled = !mergeState.canMerge || merge.isPending;
  const others = allowed.filter((m) => m !== activeMethod);

  const runMerge = (method: MergeMethod) => {
    merge.mutate(
      {
        projectId: worktree.projectId,
        branch: worktree.branch,
        number: pr.number,
        method,
      },
      { onSuccess: () => reset() },
    );
  };

  // Picking from the dropdown only swaps which method the main button
  // would run; it must NOT merge directly, or the two-step confirm guard
  // would only apply to one of the three methods.
  const pickMethod = (method: MergeMethod) => {
    if (armed) reset();
    setPickedMethod(method);
  };

  const toggleDraft = () => {
    setDraft.mutate({
      projectId: worktree.projectId,
      branch: worktree.branch,
      number: pr.number,
      draft: !pr.isDraft,
    });
  };

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

function ClosedPullRequestBox({ worktree }: { worktree: Worktree }) {
  const navigate = useNavigate();
  const { data: siblings = [] } = useWorktrees(worktree.projectId);
  const deleteMutation = useDeleteWorktree();
  const { armed, trigger } = useConfirmTwice(CONFIRM_QUICK_MS);
  const busy = deleteMutation.isPending;

  const runDelete = () => {
    deleteMutation.mutate(
      { projectId: worktree.projectId, worktreeId: worktree.id },
      {
        onSuccess: (data) => {
          if (!data.ok) return;
          // Prefer the sibling above so the user's eye stays in place.
          const index = siblings.findIndex((w) => w.id === worktree.id);
          const next =
            index >= 0
              ? (siblings[index - 1] ?? siblings[index + 1])
              : undefined;
          if (next) {
            void navigate({
              to: "/projects/$projectId/worktrees/$worktreeId",
              params: {
                projectId: worktree.projectId,
                worktreeId: next.id,
              },
              replace: true,
            });
          } else {
            void navigate({ to: "/", replace: true });
          }
        },
      },
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => trigger(runDelete)}
          className={cn(
            "text-destructive hover:bg-destructive/10 hover:text-destructive",
            armed && "bg-destructive/10",
          )}
        >
          {busy ? (
            <>
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
              Deleting…
            </>
          ) : armed ? (
            "Click again to confirm"
          ) : (
            <>
              <Trash2 aria-hidden className="size-3.5" />
              Delete worktree
            </>
          )}
        </Button>
      </div>
      {deleteMutation.error && (
        <ErrorBanner>{deleteMutation.error.message}</ErrorBanner>
      )}
    </div>
  );
}

function openPullRequest(url: string): void {
  window.api.shell
    .openExternal(url)
    .catch((err) => notifyError("Couldn't open pull request", err));
}

const STATE_LABEL: Record<PullRequestDetail["state"], string> = {
  OPEN: "Open",
  MERGED: "Merged",
  CLOSED: "Closed",
};

const TONE_TEXT: Record<PullRequestTone, string> = {
  emerald: "text-emerald-500",
  violet: "text-violet-500",
  rose: "text-rose-500",
  slate: "text-muted-foreground",
  amber: "text-amber-500",
};

function ChecksSummaryIcon({ tone }: { tone: PullRequestTone }) {
  const Icon =
    tone === "rose"
      ? CircleAlert
      : tone === "amber"
        ? Loader2
        : tone === "slate"
          ? CircleSlash
          : CircleCheck;
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0",
        TONE_TEXT[tone],
        tone === "amber" && "animate-spin",
      )}
    />
  );
}

function MergeStateIcon({ tone }: { tone: PullRequestTone }) {
  const Icon =
    tone === "rose" || tone === "amber"
      ? CircleAlert
      : tone === "slate"
        ? CircleDashed
        : CircleCheck;
  return (
    <Icon aria-hidden className={cn("size-3.5 shrink-0", TONE_TEXT[tone])} />
  );
}

const CHECK_BUCKET_ICON: Record<
  PullRequestCheckBucket,
  { Icon: typeof CircleCheck; tone: PullRequestTone }
> = {
  passed: { Icon: CircleCheck, tone: "emerald" },
  failing: { Icon: CircleAlert, tone: "rose" },
  pending: { Icon: Loader2, tone: "amber" },
  neutral: { Icon: MinusCircle, tone: "slate" },
  skipped: { Icon: CircleSlash, tone: "slate" },
};
