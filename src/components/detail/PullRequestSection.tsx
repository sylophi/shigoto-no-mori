import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  ExternalLink,
  FileDiff,
  Loader2,
  MinusCircle,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
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

export function PullRequestSection({ worktree }: { worktree: Worktree }) {
  const { data: pr } = useWorktreePullRequest(
    worktree.projectId,
    worktree.branch,
  );
  if (worktree.detached || !pr) return null;
  return (
    <section className="space-y-3">
      <SectionHeading>Pull request</SectionHeading>
      <PullRequestBody worktree={worktree} pr={pr} />
    </section>
  );
}

function PullRequestBody({
  worktree,
  pr,
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
}) {
  const { data: repoConfig } = useRepoMergeConfig(worktree.projectId);
  const { data: shigomori } = useShigomoriConfig(worktree.projectId);
  const isOpen = pr.state === "OPEN";
  const hasStats = pr.changedFiles > 0;
  const hasChecks = pr.checks.total > 0;

  return (
    <div className="space-y-4">
      <PullRequestIdentity pr={pr} />
      {(hasStats || (isOpen && hasChecks)) && (
        <div className="-mx-2 space-y-0.5">
          {hasStats && <ChangesRow worktree={worktree} pr={pr} />}
          {isOpen && hasChecks && <ChecksRow pr={pr} />}
        </div>
      )}
      {isOpen && (
        <MergeBox
          worktree={worktree}
          pr={pr}
          repoConfig={repoConfig ?? null}
          lastMergeMethod={shigomori?.lastMergeMethod}
        />
      )}
    </div>
  );
}

// Title row + meta. The left side describes the PR's state and where
// it's going; the right side carries lifecycle metadata (author + when
// it was last touched). Splitting them keeps each cluster grammatical.
function PullRequestIdentity({ pr }: { pr: PullRequestDetail }) {
  const updatedAt = new Date(pr.updatedAt);
  return (
    <div className="space-y-1.5">
      <h3 className="text-lg leading-snug font-medium select-text">
        <PullRequestTitleLink pr={pr} />{" "}
        <span className="font-normal text-muted-foreground/60">
          #{pr.number}
        </span>
      </h3>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <PullRequestStatePill pr={pr} />
          <span>into</span>
          <BranchChip name={pr.baseRefName} />
        </div>
        <span className="select-text" title={updatedAt.toLocaleString()}>
          Opened by{" "}
          <span className="text-foreground/80">@{pr.authorLogin}</span>, updated{" "}
          {formatRelativeTime(updatedAt.getTime())}
        </span>
      </div>
    </div>
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

function PullRequestStatePill({ pr }: { pr: PullRequestDetail }) {
  const { Icon, tone, label } = describePullRequest(pr);
  const stateLabel =
    pr.isDraft && pr.state === "OPEN" ? "Draft" : STATE_LABEL[pr.state];
  return (
    <a
      href={pr.url}
      onClick={(e) => {
        e.preventDefault();
        openPullRequest(pr.url);
      }}
      title={`Open ${label} on GitHub`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs whitespace-nowrap transition-colors focus-visible:outline-2",
        STATE_PILL_CLASSES[tone],
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {stateLabel}
    </a>
  );
}

// Inline code-style chip for branch names, matching GitHub's PR header
// chips. Used in the identity meta line and inside the merge box.
function BranchChip({ name }: { name: string }) {
  return (
    <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground select-text">
      {name}
    </code>
  );
}

function ChangesRow({
  worktree,
  pr,
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
}) {
  const navigate = useNavigate();
  const fileNoun = pr.changedFiles === 1 ? "file" : "files";
  return (
    <button
      type="button"
      onClick={() =>
        void navigate({
          to: "/projects/$projectId/worktrees/$worktreeId/pr-diff",
          params: { projectId: worktree.projectId, worktreeId: worktree.id },
        })
      }
      title="View pull request diff"
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <FileDiff
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="flex-1 text-foreground">
        {pr.changedFiles} {fileNoun} changed
      </span>
      <DiffStats additions={pr.additions} deletions={pr.deletions} />
      <ChevronRight
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground/40"
      />
    </button>
  );
}

function DiffStats({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span
      aria-label={`${additions} additions, ${deletions} deletions`}
      className="tabular inline-flex shrink-0 items-center gap-1.5 font-mono text-xs"
    >
      <span className="text-emerald-500">+{additions}</span>
      <span className="text-rose-500">−{deletions}</span>
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
  const { armed, trigger, reset } = useConfirmTwice(CONFIRM_QUICK_MS);
  const { primary, allowed } = resolveMergeMethod(repoConfig, lastMergeMethod);
  const mergeState = describeMergeState(pr.mergeState);

  if (!primary) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <CircleSlash aria-hidden className="size-3.5 shrink-0" />
        No merge methods are enabled for this repo.
      </p>
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
      { onSuccess: () => reset() },
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-sm">
          <MergeStateIcon tone={mergeState.tone} />
          <span className={TONE_TEXT[mergeState.tone]}>{mergeState.label}</span>
        </span>
        <div className="inline-flex items-stretch">
          <Button
            type="button"
            size="sm"
            variant={armed ? "destructive" : "outline"}
            disabled={disabled}
            onClick={() => trigger(() => runMerge(primary))}
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

const STATE_PILL_CLASSES: Record<PullRequestTone, string> = {
  emerald:
    "text-emerald-500 hover:bg-emerald-500/10 focus-visible:outline-emerald-500",
  violet:
    "text-violet-500 hover:bg-violet-500/10 focus-visible:outline-violet-500",
  rose: "text-rose-500 hover:bg-rose-500/10 focus-visible:outline-rose-500",
  slate:
    "text-muted-foreground hover:bg-muted focus-visible:outline-muted-foreground",
  amber: "text-amber-500 hover:bg-amber-500/10 focus-visible:outline-amber-500",
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
    tone === "rose" ? CircleAlert : tone === "amber" ? Loader2 : CircleCheck;
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
