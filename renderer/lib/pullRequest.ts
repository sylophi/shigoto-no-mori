import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import {
  MergeMethodSchema,
  type MergeMethod,
  type PullRequest,
  type PullRequestChecksSummary,
  type PullRequestMergeState,
  type RepoMergeConfig,
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
