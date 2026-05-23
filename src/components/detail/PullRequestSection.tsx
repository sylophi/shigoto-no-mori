import { useState } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SectionHeading } from "@/components/ui/section-heading";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/useConfirmTwice";
import { useMergePullRequest } from "@/hooks/useMergePullRequest";
import { useRepoMergeConfig } from "@/hooks/useRepoMergeConfig";
import { useShigomoriConfig } from "@/hooks/useShigomoriConfig";
import { useWorktreePullRequest } from "@/hooks/useWorktreePullRequest";
import { cn } from "@/lib/utils";
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

export function PullRequestSection({ worktree }: { worktree: Worktree }) {
  const { data: pr } = useWorktreePullRequest(
    worktree.projectId,
    worktree.branch,
  );

  if (worktree.detached || !pr) return null;

  return (
    <section className="space-y-3">
      <SectionHeading>Pull request</SectionHeading>
      <PullRequestCard worktree={worktree} pr={pr} />
    </section>
  );
}

function PullRequestCard({
  worktree,
  pr,
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
}) {
  const { data: repoConfig } = useRepoMergeConfig(worktree.projectId);
  const { data: shigomori } = useShigomoriConfig(worktree.projectId);
  const isOpen = pr.state === "OPEN";

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card/40 p-4">
      <PrHeader pr={pr} />
      {isOpen && pr.checks.total > 0 && <ChecksRow pr={pr} />}
      {isOpen && (
        <MergeRow
          worktree={worktree}
          pr={pr}
          repoConfig={repoConfig ?? null}
          lastMergeMethod={shigomori?.lastMergeMethod}
        />
      )}
    </div>
  );
}

function PrHeader({ pr }: { pr: PullRequestDetail }) {
  const { Icon, tone, label } = describePullRequest(pr);
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span
        className={cn(
          "tabular inline-flex shrink-0 items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs whitespace-nowrap",
          PILL_TONE_CLASSES[tone],
        )}
        title={label}
      >
        <Icon aria-hidden className="size-3.5" />
        {STATE_LABEL[pr.state]}
        {pr.isDraft && pr.state === "OPEN" && " · Draft"}
      </span>
      <a
        href={pr.url}
        onClick={(e) => {
          e.preventDefault();
          window.api.shell
            .openExternal(pr.url)
            .catch((err) => notifyError("Couldn't open pull request", err));
        }}
        className="group/title inline-flex min-w-0 flex-1 items-baseline gap-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring"
        title={`Open #${pr.number} on GitHub`}
      >
        <span className="truncate text-sm font-medium text-foreground group-hover/title:text-primary group-hover/title:underline">
          {pr.title}
        </span>
        <span className="tabular shrink-0 text-xs text-muted-foreground">
          #{pr.number}
        </span>
        <ExternalLink
          aria-hidden
          className="size-3 shrink-0 self-center text-muted-foreground/60 opacity-0 transition-opacity group-hover/title:opacity-100"
        />
      </a>
    </div>
  );
}

function ChecksRow({ pr }: { pr: PullRequestDetail }) {
  const [expanded, setExpanded] = useState(false);
  const summary = describeChecks(pr.checks);
  if (!summary) return null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "tabular inline-flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-muted",
          CHECK_TONE_TEXT[summary.tone],
        )}
      >
        {expanded ? (
          <ChevronDown aria-hidden className="size-3.5" />
        ) : (
          <ChevronRight aria-hidden className="size-3.5" />
        )}
        <ChecksSummaryIcon tone={summary.tone} />
        {summary.label}
      </button>
      {expanded && (
        <ul className="space-y-0.5 pl-7">
          {pr.checkList.map((check, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- check names aren't unique across providers
            <li key={`${check.name}::${i}`}>
              <CheckEntry check={check} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CheckEntry({ check }: { check: PullRequestCheck }) {
  const { Icon, tone } = CHECK_BUCKET_ICON[check.bucket];
  const Inner = (
    <>
      <Icon
        aria-hidden
        className={cn("size-3.5 shrink-0", CHECK_TONE_TEXT[tone])}
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
      <div className="flex items-center gap-2 rounded-md px-1.5 py-0.5 text-xs">
        {Inner}
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
      className="group/check flex items-center gap-2 rounded-md px-1.5 py-0.5 text-xs transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      {Inner}
    </a>
  );
}

function MergeRow({
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
  const { armed, trigger, reset } = useConfirmTwice(CONFIRM_QUICK_MS);
  const { primary, allowed } = resolveMergeMethod(repoConfig, lastMergeMethod);
  const mergeState = describeMergeState(pr.mergeState);

  if (!primary) {
    // gh said no merge methods are allowed -- still show the reason so
    // the user understands why no button is available.
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CircleSlash aria-hidden className="size-3.5" />
        No merge methods are enabled for this repo.
      </div>
    );
  }

  const disabled = !mergeState.canMerge || merge.isPending;
  const others = allowed.filter((m) => m !== primary);

  const runMerge = (method: MergeMethod) => {
    merge.mutate(
      {
        projectId: worktree.projectId,
        branch: worktree.branch,
        number: pr.number,
        method,
      },
      {
        onSuccess: () => reset(),
      },
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <MergeStateIcon tone={mergeState.tone} />
          <span className={cn(CHECK_TONE_TEXT[mergeState.tone])}>
            {mergeState.label}
          </span>
        </div>
        <div className="inline-flex items-stretch">
          <Button
            type="button"
            size="sm"
            variant={armed ? "destructive" : "default"}
            disabled={disabled}
            onClick={() =>
              trigger(() => {
                runMerge(primary);
              })
            }
            className={cn(
              others.length > 0 &&
                "rounded-r-none border-r border-r-primary-foreground/20",
            )}
          >
            {merge.isPending ? (
              <>
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
                Merging…
              </>
            ) : armed ? (
              "Click again to confirm"
            ) : (
              MERGE_METHOD_SHORT_LABEL[primary]
            )}
          </Button>
          {others.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
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
                    onClick={() => runMerge(method)}
                  >
                    {MERGE_METHOD_LABEL[method]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {merge.error && <ErrorBanner>{merge.error.message}</ErrorBanner>}
    </div>
  );
}

const STATE_LABEL: Record<PullRequestDetail["state"], string> = {
  OPEN: "Open",
  MERGED: "Merged",
  CLOSED: "Closed",
};

const PILL_TONE_CLASSES: Record<PullRequestTone, string> = {
  emerald: "bg-emerald-500/10 text-emerald-500",
  violet: "bg-violet-500/10 text-violet-500",
  rose: "bg-rose-500/10 text-rose-500",
  slate: "bg-muted text-muted-foreground",
  amber: "bg-amber-500/10 text-amber-500",
};

const CHECK_TONE_TEXT: Record<PullRequestTone, string> = {
  emerald: "text-emerald-500",
  violet: "text-violet-500",
  rose: "text-rose-500",
  slate: "text-muted-foreground",
  amber: "text-amber-500",
};

function ChecksSummaryIcon({ tone }: { tone: PullRequestTone }) {
  if (tone === "rose") {
    return <CircleAlert aria-hidden className="size-3.5" />;
  }
  if (tone === "amber") {
    return <Loader2 aria-hidden className="size-3.5 animate-spin" />;
  }
  return <CircleCheck aria-hidden className="size-3.5" />;
}

function MergeStateIcon({ tone }: { tone: PullRequestTone }) {
  const Icon =
    tone === "rose" || tone === "amber"
      ? CircleAlert
      : tone === "slate"
        ? CircleDashed
        : CircleCheck;
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", CHECK_TONE_TEXT[tone])}
    />
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
