import type { UseQueryResult } from "@tanstack/react-query";
import { GitPullRequest, GitPullRequestDraft } from "lucide-react";
import type {
  PullRequestCandidate,
  PullRequestCandidateList,
  Worktree,
} from "@shared/schemas";
import { ErrorBanner } from "@/components/ui/error-banner";
import { pullRequestBlockedBy } from "@/lib/pullRequest";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";

// The whole "From pull request" source: the list, whichever state
// stands in for it, and the line describing what the selected PR checks
// out. The form hands over the query rather than its unpacked states so
// the four ways this can render stay in one place.
export function PullRequestSource({
  query,
  unavailableText,
  selected,
  onSelect,
  worktreeByBranch,
  disabled,
}: {
  query: UseQueryResult<PullRequestCandidateList>;
  // Set when the query came back "unavailable". The form shows the same
  // line on the mode toggle.
  unavailableText: string | undefined;
  selected: PullRequestCandidate | null;
  onSelect: (pr: PullRequestCandidate) => void;
  worktreeByBranch: Map<string, Worktree>;
  disabled?: boolean;
}) {
  return (
    <>
      <span className="block pt-2 text-sm font-medium">Pull request</span>
      {query.isPending ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          Loading pull requests…
        </p>
      ) : query.isError ? (
        <ErrorBanner>{query.error.message}</ErrorBanner>
      ) : unavailableText ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          {unavailableText}
        </p>
      ) : (
        <PullRequestPicker
          pullRequests={
            query.data.status === "ok" ? query.data.pullRequests : []
          }
          selected={selected}
          onSelect={onSelect}
          worktreeByBranch={worktreeByBranch}
          disabled={disabled}
        />
      )}
      {selected && <SelectionNote pr={selected} />}
    </>
  );
}

// What the checkout will actually do, in the PR's own terms.
function SelectionNote({ pr }: { pr: PullRequestCandidate }) {
  return (
    <p className="text-xs text-muted-foreground">
      Checks out{" "}
      <span className="font-mono text-foreground/80">
        {pr.fromFork ? `refs/pull/${pr.number}/head` : pr.headRefName}
      </span>
      {pr.fromFork
        ? // Deliberately doesn't name the local branch: a fork head that
          // collides with a local name gets an owner-prefixed one
          // instead, and which it lands on depends on git config the
          // form can't read.
          ". The head lives in a fork, so nothing is configured to push back to it."
        : ", tracking the branch on the remote."}
    </p>
  );
}

// The list behind the "From pull request" mode. One row per open PR,
// and picking one sets the branch the worktree checks out. Rows the resolver
// has no free branch name left for are shown but not selectable --
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
          occupiedBy={pullRequestBlockedBy(pr, worktreeByBranch)}
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
          pr.isDraft ? "text-muted-foreground" : "text-emerald-500",
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
