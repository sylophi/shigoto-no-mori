import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { forkBranchCandidates } from "@shared/git/branches";
import { pluralize } from "./pluralize";
import {
  isBranchsPullRequest,
  MergeMethodSchema,
  type MergeMethod,
  type PullRequest,
  type PullRequestCandidate,
  type GhUnavailableReason,
  type PullRequestCheck,
  type PullRequestCheckBucket,
  type PullRequestChecksSummary,
  type PullRequestDetail,
  type PullRequestMergeState,
  type PullRequestReviewerState,
  type PullRequestReviews,
  type PullRequestSourceUnavailable,
  type RepoMergeConfig,
  type Worktree,
} from "@shigomori/contracts/schemas";

export type PullRequestTone = "emerald" | "violet" | "rose" | "slate" | "amber";

export interface PullRequestDescriptor {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: PullRequestTone;
  label: string;
}

export function describePullRequest(pr: PullRequest): PullRequestDescriptor {
  if (pr.state === "MERGED") {
    return { Icon: GitMerge, tone: "violet", label: "Merged PR" };
  }
  if (pr.state === "CLOSED") {
    return { Icon: GitPullRequestClosed, tone: "rose", label: "Closed PR" };
  }
  if (pr.isDraft) {
    return { Icon: GitPullRequestDraft, tone: "slate", label: "Draft PR" };
  }
  return { Icon: GitPullRequest, tone: "emerald", label: "Open PR" };
}

// Why gh can't be used on a device, each line naming the fix.
export const GH_UNAVAILABLE_TEXT: Record<GhUnavailableReason, string> = {
  "integration-off": "The GitHub integration is off in Settings.",
  "gh-missing": "The GitHub CLI (gh) isn't installed.",
  "gh-signed-out": "The GitHub CLI isn't signed in. Run gh auth login.",
};

// Why the new-worktree form can't offer the pull request source. Each
// line names the thing to fix. None of them are recoverable from inside
// the form, so there's no action attached.
export const PULL_REQUEST_SOURCE_UNAVAILABLE_TEXT: Record<
  PullRequestSourceUnavailable,
  string
> = {
  ...GH_UNAVAILABLE_TEXT,
  "no-github-remote": "This project has no GitHub remote.",
  "gh-failed": "Couldn't reach GitHub.",
};

const FOLDER_SLUG_WORDS = 4;
const FOLDER_SLUG_MAX = 28;

// Folder name for a PR checkout: "pr-142-adds-a-thing". The number
// leads because that's how PRs get talked about. The slug is the first
// few title words, only there so the folder is recognizable at a glance
// in a list of ten worktrees. Callers still run it through
// sanitizeBranchForPath. This only decides the shape.
export function pullRequestFolderName(pr: PullRequestCandidate): string {
  const words = pr.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, FOLDER_SLUG_WORDS);
  const slug = words.join("-").slice(0, FOLDER_SLUG_MAX).replace(/-+$/, "");
  return slug ? `pr-${pr.number}-${slug}` : `pr-${pr.number}`;
}

// The local branch names a PR checkout can land on, in the order the
// resolver tries them. Same-repo heads only ever land on the head name.
// Fork heads have the owner-prefixed fallback too (forkBranchCandidates
// is shared with the resolver so the two can't disagree). Callers
// checking whether a PR is already checked out have to consider every
// candidate, or the common fork case looks occupied when it isn't.
function pullRequestBranchCandidates(pr: PullRequestCandidate): string[] {
  if (!pr.fromFork) return [pr.headRefName];
  return forkBranchCandidates(
    pr.number,
    pr.headRefName,
    pr.headRepo?.split("/")[0],
  );
}

// The worktree standing in the way of checking a PR out, if any. Only a
// PR with no candidate name left is genuinely blocked. Checking the
// head name alone would report every fork PR opened off its author's
// default branch as taken. Names the *last* candidate's holder: a
// blocked fork PR is usually blocked because that PR is already checked
// out under the fallback name, and pointing at the worktree holding an
// unrelated branch of the same name sends the user to the wrong row.
export function pullRequestBlockedBy(
  pr: PullRequestCandidate,
  worktreeByBranch: Map<string, Worktree>,
): Worktree | undefined {
  const holders = pullRequestBranchCandidates(pr).map((branch) =>
    worktreeByBranch.get(branch),
  );
  return holders.every((held) => held !== undefined)
    ? holders.at(-1)
    : undefined;
}

export interface MergeStateDescriptor {
  label: string;
  tone: PullRequestTone;
  canMerge: boolean;
}

// The verdicts auto-merge is for: the same two as the CLI's
// autoMergeArms (cli/cmd_merge.go), which says why.
function autoMergeArms(state: PullRequestMergeState): boolean {
  return state === "BLOCKED" || state === "BEHIND";
}

// Whether the merge button arms auto-merge instead of merging: the
// repo allows it, the PR is neither a draft nor in a stack (a stack
// lands one PR at a time or through GitHub's stack merge, and neither
// arms it, cli/stack.go), and the verdict is one waiting fixes. The
// CLI decides the same way from the same inputs (cli/cmd_merge.go
// execMerge). This only shapes the button.
export function armsAutoMerge(
  config: RepoMergeConfig | null,
  pr: PullRequestDetail,
  stacked: boolean,
): boolean {
  return (
    (config?.autoMerge ?? false) &&
    !stacked &&
    !pr.isDraft &&
    autoMergeArms(pr.mergeState)
  );
}

// Human-friendly reason text + a single "is the merge button live?" flag
// per mergeStateStatus. `isDraft` overrides gh's mergeStateStatus
// because gh often reports CLEAN for draft PRs (branches don't
// conflict, even if the PR isn't ready for review). We let gh tell us
// off if the user pushes through, but the obvious blockers (draft,
// conflicts, blocked) are reflected in the disabled state. With
// `autoMerge` (armsAutoMerge) the waiting verdicts turn live: the
// button arms auto-merge instead.
export function describeMergeState(
  state: PullRequestMergeState,
  isDraft: boolean,
  autoMerge = false,
): MergeStateDescriptor {
  if (isDraft) {
    return { label: "Draft", tone: "slate", canMerge: false };
  }
  switch (state) {
    case "CLEAN":
    case "HAS_HOOKS":
      return { label: "Ready to merge", tone: "emerald", canMerge: true };
    case "UNSTABLE":
      return {
        label: "Mergeable, checks not passing",
        tone: "amber",
        canMerge: true,
      };
    case "BEHIND":
      return {
        label: autoMerge
          ? "Behind base, waiting for an update"
          : "Behind base, will update first",
        tone: "amber",
        canMerge: true,
      };
    case "BLOCKED":
      return autoMerge
        ? { label: "Waiting on requirements", tone: "amber", canMerge: true }
        : {
            label: "Blocked by branch protections",
            tone: "rose",
            canMerge: false,
          };
    case "DIRTY":
      return { label: "Conflicts with base", tone: "rose", canMerge: false };
    // DRAFT on a PR that isn't one is GitHub still recomputing the
    // merge state after the PR was marked ready, not a verdict
    // (mergeStateSettling).
    case "DRAFT":
    case "UNKNOWN":
      return {
        label: "Mergeable state unknown",
        tone: "slate",
        canMerge: false,
      };
  }
}

// The merge box's one status: what most stands between the PR and
// landing, said once. The merge state alone often only restates its
// cause ("Waiting on requirements" while checks run), so the cause
// speaks instead: conflicts, then failing checks (amber when GitHub
// would merge anyway), then running checks, then a review the rule
// wants, then whatever the merge state says. Armed auto-merge keeps
// its own words past all but conflicts and failing checks. `by`
// says where the words came from, so the checks chip draws their
// icon and the reviews chip can drop words it would repeat.
export interface MergeVerdict {
  label: string;
  tone: PullRequestTone;
  by: "merge" | "checks" | "reviews";
}

const said = (
  { label, tone }: { label: string; tone: PullRequestTone },
  by: MergeVerdict["by"],
): MergeVerdict => ({ label, tone, by });

export function describeMergeVerdict(
  pr: PullRequestDetail,
  status: { label: string; tone: PullRequestTone },
  armed: boolean,
): MergeVerdict {
  if (pr.isDraft || pr.mergeState === "DIRTY") return said(status, "merge");
  const checks = describeChecks(pr.checks);
  if (checks?.tone === "rose") {
    // A failing check GitHub doesn't require (it would still merge)
    // warns rather than blocks.
    const mergeable =
      pr.mergeState === "UNSTABLE" ||
      pr.mergeState === "CLEAN" ||
      pr.mergeState === "HAS_HOOKS";
    return said(
      { label: checks.label, tone: mergeable ? "amber" : "rose" },
      "checks",
    );
  }
  // Armed, the status already says it waits ("Will squash and merge
  // when ready") and on what is the checks' spinner and the reviews
  // chip, so it keeps its words: auto-merge being on is the news.
  if (armed) return said(status, checks?.tone === "amber" ? "checks" : "merge");
  if (checks?.tone === "amber") return said(checks, "checks");
  if (pr.mergeState === "BLOCKED" && pr.reviews) {
    const reviews = describeReviews(pr.reviews);
    if (reviews && (reviews.tone === "amber" || reviews.tone === "rose")) {
      return said(reviews, "reviews");
    }
  }
  return said(status, "merge");
}

// The PR a worktree page's lookup answered, or none when it isn't the
// branch's own (isBranchsPullRequest). A peer's host on an older build
// still answers with a stranger's fork PR, and the page merges and
// drafts by its number.
export function ownBranchPullRequest(
  pr: PullRequestDetail | null,
): PullRequestDetail | null {
  return pr !== null && isBranchsPullRequest(pr) ? pr : null;
}

// A device's branch to PR map, without the PRs that aren't their
// branch's own, which a peer's host on an older build still lists.
// Every reader of the map (sidebar, inbox, stacks, palette) gets it
// through here.
export function ownBranchPullRequests(
  prs: Record<string, PullRequest>,
): Record<string, PullRequest> {
  return Object.fromEntries(
    Object.entries(prs).filter(([, pr]) => isBranchsPullRequest(pr)),
  );
}

// GitHub computes mergeStateStatus in the background, so right after a
// PR is marked ready gh still reports DRAFT (or UNKNOWN) for a while
// even though isDraft has already flipped. The worktree page polls
// while this holds (useWorktreePullRequest).
export function mergeStateSettling(pr: PullRequestDetail): boolean {
  return (
    pr.state === "OPEN" &&
    !pr.isDraft &&
    (pr.mergeState === "UNKNOWN" || pr.mergeState === "DRAFT")
  );
}

export interface ChecksDescriptor {
  label: string;
  tone: PullRequestTone;
}

// Returns null when the PR has no checks at all. Callers should skip
// the checks control entirely rather than show "0 checks". The label
// leads with the worst news, and a failing run still says what's
// pending, since either is a reason the PR isn't green yet.
export function describeChecks(
  summary: PullRequestChecksSummary,
): ChecksDescriptor | null {
  if (summary.total === 0) return null;
  if (summary.failing > 0) {
    const failing = `${pluralize(summary.failing, "check")} failing`;
    return {
      label:
        summary.pending > 0
          ? `${failing}, ${summary.pending} pending`
          : failing,
      tone: "rose",
    };
  }
  if (summary.pending > 0) {
    return {
      label: `${pluralize(summary.pending, "check")} pending`,
      tone: "amber",
    };
  }
  // Only neutral / skipped runs in the rollup. They didn't pass, they
  // just didn't fail. Calling that "passed" would be misleading.
  if (summary.passed === 0) {
    return {
      label: `${pluralize(summary.total, "check")} skipped`,
      tone: "slate",
    };
  }
  return {
    label: `${pluralize(summary.passed, "check")} passed`,
    tone: "emerald",
  };
}

export interface ReviewsDescriptor {
  label: string;
  tone: PullRequestTone;
}

// Returns null when nobody has reviewed or been asked to and the base
// branch requires no review: callers skip the reviews control then.
// A request for changes leads unless GitHub already calls the PR
// approved (a reviewer without write access can't block it). Then
// GitHub's decision when the branch has a review rule, and without
// one the reviews themselves.
export function describeReviews({
  decision,
  reviewers,
}: PullRequestReviews): ReviewsDescriptor | null {
  const approvals = reviewers.filter((r) => r.state === "APPROVED").length;
  if (
    decision === "CHANGES_REQUESTED" ||
    (decision !== "APPROVED" &&
      reviewers.some((r) => r.state === "CHANGES_REQUESTED"))
  ) {
    return { label: "Changes requested", tone: "rose" };
  }
  // The rule may want more approvals or one from a code owner, and
  // GitHub doesn't say which, so the count is only what's there so far.
  if (decision === "REVIEW_REQUIRED") {
    return {
      label:
        approvals > 0
          ? `Review required, ${pluralize(approvals, "approval")}`
          : "Review required",
      tone: "amber",
    };
  }
  if (approvals > 0) {
    return { label: pluralize(approvals, "approval"), tone: "emerald" };
  }
  if (decision === "APPROVED") return { label: "Approved", tone: "emerald" };
  if (reviewers.some((r) => r.state === "REQUESTED")) {
    return { label: "Review requested", tone: "slate" };
  }
  if (reviewers.length > 0) return { label: "No approvals yet", tone: "slate" };
  return null;
}

// The reviewers, worst news first: a request for changes, approvals,
// comments, then whoever hasn't answered yet.
const REVIEWER_STATE_ORDER: readonly PullRequestReviewerState[] = [
  "CHANGES_REQUESTED",
  "APPROVED",
  "COMMENTED",
  "REQUESTED",
];

export function sortReviewersWorstFirst(
  reviewers: PullRequestReviews["reviewers"],
): PullRequestReviews["reviewers"] {
  return reviewers.toSorted(
    (a, b) =>
      REVIEWER_STATE_ORDER.indexOf(a.state) -
      REVIEWER_STATE_ORDER.indexOf(b.state),
  );
}

// Worst first, so a failing run leads.
const CHECK_BUCKET_ORDER: readonly PullRequestCheckBucket[] = [
  "failing",
  "pending",
  "passed",
  "neutral",
  "skipped",
];

// The rollup's counts, worst first, zeros left out: "1 failing,
// 2 pending, 3 passed".
export function checksBreakdown(summary: PullRequestChecksSummary): string {
  return CHECK_BUCKET_ORDER.filter((bucket) => summary[bucket] > 0)
    .map((bucket) => `${summary[bucket]} ${bucket}`)
    .join(", ");
}

export function sortChecksWorstFirst(
  checks: readonly PullRequestCheck[],
): PullRequestCheck[] {
  return checks.toSorted(
    (a, b) =>
      CHECK_BUCKET_ORDER.indexOf(a.bucket) -
      CHECK_BUCKET_ORDER.indexOf(b.bucket),
  );
}

// Also the merge button's label: each one already reads naturally as
// the button, so there is no separate short form.
export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

// The same labels when the button arms auto-merge instead: "Squash
// and merge when ready", so the method reads the way it does on the
// plain button.
export function autoMergeButtonLabel(method: MergeMethod): string {
  return `${MERGE_METHOD_LABEL[method]} when ready`;
}

// The status line while auto-merge is armed: GitHub merges the PR
// with the method the moment its requirements are met, so the merge
// button gives way to "Disable auto-merge".
export function describeArmedAutoMerge(method: MergeMethod): {
  label: string;
  tone: PullRequestTone;
} {
  return {
    label: `Will ${MERGE_METHOD_LABEL[method].toLowerCase()} when ready`,
    tone: "amber",
  };
}

// Picks the user's saved method when it's still allowed by the repo;
// otherwise falls back to the first allowed method in the canonical
// order. Returns null when nothing is allowed at all (degenerate repo
// config or gh failed to report).
export function resolveMergeMethod(
  config: RepoMergeConfig | null,
  lastPicked: MergeMethod | undefined,
): { primary: MergeMethod | null; allowed: MergeMethod[] } {
  // A null config means we couldn't read it. Assume every method is
  // allowed so the user isn't blocked by our missing data, and no
  // auto-merge, since GitHub refuses to arm it where the repo doesn't
  // allow it (the CLI assumes the same, cli/cmd_merge.go).
  const allowedMap: RepoMergeConfig = config ?? {
    merge: true,
    squash: true,
    rebase: true,
    autoMerge: false,
  };
  const allowed = MergeMethodSchema.literals.filter((m) => allowedMap[m]);
  const [fallback] = allowed;
  if (fallback === undefined) return { primary: null, allowed: [] };
  const primary =
    lastPicked && allowed.includes(lastPicked) ? lastPicked : fallback;
  return { primary, allowed };
}
