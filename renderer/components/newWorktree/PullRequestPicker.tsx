import { GitPullRequest, GitPullRequestDraft } from "lucide-react";
import type { PullRequestCandidate, Worktree } from "@shared/schemas";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";

// The list behind the "From pull request" mode. One row per open PR;
// picking one sets the branch the worktree checks out. Rows whose head
// branch is already a HEAD somewhere are shown but not selectable --
// hiding them would leave the user hunting for a PR that's right there
// on GitHub.
export function PullRequestPicker({
  pullRequests,
  selected,
  onSelect,
  worktreeByBranch,
  disabled,
}: {
  pullRequests: PullRequestCandidate[];
  selected: PullRequestCandidate | null;
  onSelect: (pr: PullRequestCandidate) => void;
  // Head branch -> the worktree already sitting on it, when there is one.
  worktreeByBranch: Map<string, Worktree>;
  disabled?: boolean;
}) {
  if (pullRequests.length === 0) {
    return (
      <p className="rounded-md border border-input px-3 py-6 text-center text-sm text-muted-foreground">
        No open pull requests.
      </p>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label="Pull request"
      className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-input"
    >
      {pullRequests.map((pr) => (
        <PullRequestRow
          key={pr.number}
          pr={pr}
          selected={selected?.number === pr.number}
          occupiedBy={worktreeByBranch.get(pr.headRefName)}
          onSelect={() => onSelect(pr)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function PullRequestRow({
  pr,
  selected,
  occupiedBy,
  onSelect,
  disabled,
}: {
  pr: PullRequestCandidate;
  selected: boolean;
  occupiedBy: Worktree | undefined;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const Icon = pr.isDraft ? GitPullRequestDraft : GitPullRequest;
  const taken = occupiedBy !== undefined;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      disabled={disabled || taken}
      title={
        taken
          ? `${pr.headRefName} is already checked out in ${occupiedBy.name}`
          : undefined
      }
      className={cn(
        "flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        (disabled || taken) &&
          "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          pr.isDraft ? "text-muted-foreground" : "text-emerald-600",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">
          {pr.title}{" "}
          <span className="text-muted-foreground/60">#{pr.number}</span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          @{pr.authorLogin} ·{" "}
          <span className="font-mono">{pr.headRefName}</span>
          {pr.headRepo && <> · fork {pr.headRepo}</>}
          {taken && <> · in {occupiedBy.name}</>}
        </span>
      </span>
      <span className="shrink-0 pt-0.5 text-xs text-muted-foreground/70">
        {formatRelativeTime(new Date(pr.updatedAt).getTime())}
      </span>
    </button>
  );
}
