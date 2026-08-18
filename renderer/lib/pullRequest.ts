import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { forkBranchCandidates } from "@shared/branches";
import {
  MergeMethodSchema,
  type MergeMethod,
  type PullRequest,
  type PullRequestCandidate,
  type PullRequestChecksSummary,
  type PullRequestMergeState,
  type PullRequestSourceUnavailable,
  type RepoMergeConfig,
  type Worktree,
} from "@shared/schemas";

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

// Why the new-worktree form can't offer the pull request source. Each
// line names the thing to fix. None of them are recoverable from inside
// the form, so there's no action attached.
export const PULL_REQUEST_SOURCE_UNAVAILABLE_TEXT: Record<
  PullRequestSourceUnavailable,
  string
> = {
  "integration-off": "The GitHub integration is off in Settings.",
  "gh-missing": "The GitHub CLI (gh) isn't installed.",
  "gh-signed-out": "The GitHub CLI isn't signed in. Run gh auth login.",
  "no-github-remote": "This project has no GitHub remote.",
  "gh-failed": "Couldn't reach GitHub.",
};

const FOLDER_SLUG_WORDS = 4;
const FOLDER_SLUG_MAX = 28;

// Folder name for a PR checkout: "pr-142-adds-a-thing". The number
// leads because that's how PRs get talked about. The slug is the first
// few title words, only there so the folder is recognizable at a glance
// in a list of ten worktrees. Callers still run it through
// sanitizeBranchForPath -- this only decides the shape.
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
export function pullRequestBranchCandidates(
  pr: PullRequestCandidate,
): string[] {
  if (!pr.fromFork) return [pr.headRefName];
  return forkBranchCandidates(
    pr.number,
    pr.headRefName,
    pr.headRepo?.split("/")[0],
  );
}

// The worktree standing in the way of checking a PR out, if any. Only a
// PR with no candidate name left is genuinely blocked -- checking the
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

// Human-friendly reason text + a single "is the merge button live?" flag
// per mergeStateStatus. `isDraft` overrides gh's mergeStateStatus
// because gh often reports CLEAN for draft PRs (branches don't
// conflict, even if the PR isn't ready for review). We let gh tell us
// off if the user pushes through, but the obvious blockers (draft,
// conflicts, blocked) are reflected in the disabled state.
export function describeMergeState(
  state: PullRequestMergeState,
  isDraft: boolean,
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
        label: "Behind base, will update first",
        tone: "amber",
        canMerge: true,
      };
    case "BLOCKED":
      return {
        label: "Blocked by branch protections",
        tone: "rose",
        canMerge: false,
      };
    case "DIRTY":
      return { label: "Conflicts with base", tone: "rose", canMerge: false };
    case "DRAFT":
      return { label: "Draft", tone: "slate", canMerge: false };
    case "UNKNOWN":
      return {
        label: "Mergeable state unknown",
        tone: "slate",
        canMerge: false,
      };
  }
}

export interface ChecksDescriptor {
  label: string;
  tone: PullRequestTone;
}

// Returns null when the PR has no checks at all -- callers should skip
// rendering the row entirely rather than show "0 checks".
export function describeChecks(
  summary: PullRequestChecksSummary,
): ChecksDescriptor | null {
  if (summary.total === 0) return null;
  const checks = summary.total === 1 ? "check" : "checks";
  if (summary.failing > 0) {
    return {
      label: `${summary.failing} of ${summary.total} ${checks} failing`,
      tone: "rose",
    };
  }
  if (summary.pending > 0) {
    return {
      label: `${summary.pending} of ${summary.total} ${checks} pending`,
      tone: "amber",
    };
  }
  // Only neutral / skipped runs in the rollup -- they didn't pass, they
  // just didn't fail. Calling that "passed" would be misleading.
  if (summary.passed === 0) {
    return {
      label: `${summary.total} ${checks} skipped`,
      tone: "slate",
    };
  }
  if (summary.passed === summary.total) {
    return {
      label: `${summary.total} ${checks} passed`,
      tone: "emerald",
    };
  }
  return {
    label: `${summary.passed} of ${summary.total} ${checks} passed`,
    tone: "emerald",
  };
}

export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

// Short label is only different from the long one when it actually
// shortens; squash and rebase already read naturally as the button.
export const MERGE_METHOD_SHORT_LABEL: Record<MergeMethod, string> = {
  merge: "Merge",
  squash: MERGE_METHOD_LABEL.squash,
  rebase: MERGE_METHOD_LABEL.rebase,
};

// Picks the user's saved method when it's still allowed by the repo;
// otherwise falls back to the first allowed method in the canonical
// order. Returns null when nothing is allowed at all (degenerate repo
// config or gh failed to report).
export function resolveMergeMethod(
  config: RepoMergeConfig | null,
  lastPicked: MergeMethod | undefined,
): { primary: MergeMethod | null; allowed: MergeMethod[] } {
  // A null config means we couldn't read it -- assume everything's
  // allowed so the user isn't blocked by our missing data.
  const allowedMap: RepoMergeConfig = config ?? {
    merge: true,
    squash: true,
    rebase: true,
  };
  const allowed = MergeMethodSchema.options.filter((m) => allowedMap[m]);
  if (allowed.length === 0) return { primary: null, allowed: [] };
  const primary =
    lastPicked && allowed.includes(lastPicked) ? lastPicked : allowed[0];
  return { primary, allowed };
}
