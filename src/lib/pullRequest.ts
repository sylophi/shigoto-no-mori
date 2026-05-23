import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type {
  MergeMethod,
  PullRequest,
  PullRequestChecksSummary,
  PullRequestMergeState,
  RepoMergeConfig,
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

export interface MergeStateDescriptor {
  label: string;
  tone: PullRequestTone;
  canMerge: boolean;
}

// Human-friendly reason text + a single "is the merge button live?" flag
// per mergeStateStatus. We let gh tell us off if the user pushes
// through, but the obvious blockers (conflicts, draft, blocked) are
// reflected in the disabled state.
export function describeMergeState(
  state: PullRequestMergeState,
): MergeStateDescriptor {
  switch (state) {
    case "CLEAN":
      return { label: "Ready to merge", tone: "emerald", canMerge: true };
    case "HAS_HOOKS":
      return {
        label: "Ready to merge (post-merge hooks will run)",
        tone: "emerald",
        canMerge: true,
      };
    case "UNSTABLE":
      return {
        label: "Mergeable with failing or pending checks",
        tone: "amber",
        canMerge: true,
      };
    case "BEHIND":
      return {
        label: "Behind base branch — gh will update before merging",
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
      return {
        label: "Draft — mark as ready to merge",
        tone: "slate",
        canMerge: false,
      };
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
  if (summary.failing > 0) {
    return {
      label: `${summary.failing} failing · ${summary.total} total`,
      tone: "rose",
    };
  }
  if (summary.pending > 0) {
    return {
      label: `${summary.pending} pending · ${summary.total} total`,
      tone: "amber",
    };
  }
  const passing = summary.passed + summary.neutral + summary.skipped;
  return {
    label:
      passing === summary.total
        ? `${summary.total} ${summary.total === 1 ? "check" : "checks"} passed`
        : `${passing} of ${summary.total} passed`,
    tone: "emerald",
  };
}

export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

export const MERGE_METHOD_SHORT_LABEL: Record<MergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

const MERGE_METHOD_FALLBACK: readonly MergeMethod[] = [
  "merge",
  "squash",
  "rebase",
];

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
  const allowed = MERGE_METHOD_FALLBACK.filter((m) => allowedMap[m]);
  if (allowed.length === 0) return { primary: null, allowed: [] };
  const primary =
    lastPicked && allowed.includes(lastPicked) ? lastPicked : allowed[0];
  return { primary, allowed };
}
