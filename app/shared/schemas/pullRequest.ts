import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ProjectScopedPayloadSchema } from "./payloads";

const PullRequestNumberSchema = Schema.Int.check(Schema.isGreaterThan(0));

const isUrl = (value: string): boolean => {
  try {
    return Boolean(new URL(value));
  } catch {
    return false;
  }
};

// A URL as GitHub and CI integrations write it: read with the
// surrounding whitespace, and any tab or newline inside, taken out.
const UrlSchema = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter((url: string) => isUrl(url) || "Invalid URL"),
    ),
    SchemaTransformation.transform({
      decode: (url: string) => url.trim().replace(/[\t\n\r]/g, ""),
      encode: (url: string) => url,
    }),
  ),
);

export const PullRequestStateSchema = Schema.Literals([
  "OPEN",
  "CLOSED",
  "MERGED",
]);

export const PullRequestSchema = Schema.Struct({
  number: PullRequestNumberSchema,
  url: UrlSchema,
  title: Schema.String,
  state: PullRequestStateSchema,
  isDraft: Schema.Boolean,
  // The branch the PR merges into ("main", or another PR's head when
  // the PR sits in a stack). On the slim shape because the stack is
  // read off the project-wide map: a PR whose base is another PR's
  // head is stacked on it (shared/pullRequestStack.ts).
  baseRefName: Schema.String,
  // Whether the PR comes from a fork. A branch name is matched across
  // every fork, so one from a fork may be a stranger's branch of the
  // same name (lib/worktreeTitle.ts). Absent from a host on an older
  // build.
  isCrossRepository: Schema.optional(Schema.Boolean),
});
export type PullRequest = typeof PullRequestSchema.Type;

// The slim fields, in PullRequestSchema's declaration order, read off
// the schema so the strip and the equality below stay in lockstep with
// it: a field added there is carried and compared here too.
const PULL_REQUEST_KEYS = Object.keys(
  PullRequestSchema.fields,
) as (keyof PullRequest)[];

// Strip a PullRequestDetail to the slim PullRequest fields used by the
// sidebar's project-wide map.
export function toSlimPullRequest(pr: PullRequest): PullRequest {
  return Object.fromEntries(
    PULL_REQUEST_KEYS.map((key) => [key, pr[key]]),
  ) as PullRequest;
}

// Field-by-field equality. Used to gate cache write-throughs and sweep
// broadcasts so unchanged PRs don't notify observers.
export function pullRequestsEqual(a: PullRequest, b: PullRequest): boolean {
  return PULL_REQUEST_KEYS.every((key) => a[key] === b[key]);
}

// Whether a branch's PR (null: the branch has none) is what the
// project-wide map holds for it. A PullRequestDetail compares on its
// slim fields.
export function matchesMapEntry(
  pr: PullRequest | null,
  entry: PullRequest | undefined,
): boolean {
  return pr === null
    ? entry === undefined
    : entry !== undefined && pullRequestsEqual(pr, entry);
}

// GraphQL's PullRequest.mergeStateStatus, surfaced verbatim so the
// renderer can pick the right reason text. UNKNOWN covers both "still
// computing" and "gh didn't report it". The UI treats both the same.
export const PullRequestMergeStateSchema = Schema.Literals([
  "CLEAN",
  "BLOCKED",
  "BEHIND",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);
export type PullRequestMergeState = typeof PullRequestMergeStateSchema.Type;

const PullRequestCheckBucketSchema = Schema.Literals([
  "passed",
  "failing",
  "pending",
  "neutral",
  "skipped",
]);
export type PullRequestCheckBucket = typeof PullRequestCheckBucketSchema.Type;

const PullRequestCheckSchema = Schema.Struct({
  name: Schema.String,
  bucket: PullRequestCheckBucketSchema,
  url: Schema.optional(UrlSchema),
});
export type PullRequestCheck = typeof PullRequestCheckSchema.Type;

const PullRequestChecksSummarySchema = Schema.Struct({
  total: Schema.Natural,
  passed: Schema.Natural,
  failing: Schema.Natural,
  pending: Schema.Natural,
  neutral: Schema.Natural,
  skipped: Schema.Natural,
});
export type PullRequestChecksSummary =
  typeof PullRequestChecksSummarySchema.Type;

export function summarizeChecks(
  checks: readonly PullRequestCheck[],
): PullRequestChecksSummary {
  const summary = {
    total: checks.length,
    passed: 0,
    failing: 0,
    pending: 0,
    neutral: 0,
    skipped: 0,
  };
  for (const c of checks) {
    summary[c.bucket] += 1;
  }
  return summary;
}

// GraphQL's PullRequest.reviewDecision: the verdict of the base
// branch's required-review rule. null when the branch has no such rule,
// so approvals still count but nothing waits on them.
export const PullRequestReviewDecisionSchema = Schema.Literals([
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
]);

// Where one reviewer stands: their latest submitted review, or
// REQUESTED while they've been asked and haven't given one. Dismissed
// and unsubmitted (PENDING) reviews are left out on the host: neither
// says anything about the PR.
export const PullRequestReviewerStateSchema = Schema.Literals([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "REQUESTED",
]);
export type PullRequestReviewerState =
  typeof PullRequestReviewerStateSchema.Type;

const PullRequestReviewsSchema = Schema.Struct({
  decision: Schema.NullOr(PullRequestReviewDecisionSchema),
  // A user's login, or org/team for a request to a team.
  reviewers: Schema.Array(
    Schema.Struct({
      login: Schema.String,
      state: PullRequestReviewerStateSchema,
    }),
  ),
});
export type PullRequestReviews = typeof PullRequestReviewsSchema.Type;

export const MergeMethodSchema = Schema.Literals(["merge", "squash", "rebase"]);
export type MergeMethod = typeof MergeMethodSchema.Type;

// Rich projection of the open worktree's PR. Slim PullRequest is kept
// for the project-wide sweep that feeds the sidebar dots, since the
// extra fields make `gh pr list` materially slower.
export const PullRequestDetailSchema = Schema.Struct({
  ...PullRequestSchema.fields,
  // The PR's description, markdown as written on GitHub: the worktree
  // page shows it in place of the worktree's own (useWorktreeTitle).
  // Absent from a host on an older build.
  body: Schema.optional(Schema.String),
  mergeState: PullRequestMergeStateSchema,
  // The method auto-merge is armed with, or null when it isn't:
  // GitHub merges the PR with it once the base branch's rules are met.
  autoMerge: Schema.NullOr(MergeMethodSchema),
  // GitHub login of whoever opened the PR. Worktrees may be checked
  // out by teammates' branches, so the author isn't always the local user.
  authorLogin: Schema.String,
  // ISO 8601 timestamp of the PR's last update (commit, comment, etc.).
  updatedAt: Schema.String,
  additions: Schema.Natural,
  deletions: Schema.Natural,
  changedFiles: Schema.Natural,
  checks: PullRequestChecksSummarySchema,
  checkList: Schema.Array(PullRequestCheckSchema),
  // Absent from a host on an older build.
  reviews: Schema.optional(PullRequestReviewsSchema),
});
export type PullRequestDetail = typeof PullRequestDetailSchema.Type;

// Per-repo merge button settings from GitHub. All three methods may be
// allowed, or only a subset (some teams squash-only). UI hides disabled
// methods rather than disabling them. autoMerge: the repo lets a PR
// that is waiting on its base branch's rules be armed to merge on its
// own once they are met, which is what the merge button offers then.
export const RepoMergeConfigSchema = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
  autoMerge: Schema.Boolean,
});
export type RepoMergeConfig = typeof RepoMergeConfigSchema.Type;

// What became of a merge (cli/cmd_merge.go mergeOutcome): the PR
// landed, a merge queue took it, or auto-merge was armed and GitHub
// lands it once its requirements are met. "merged" leads so a
// schema-derived stub picks it.
export const MergeOutcomeSchema = Schema.Literals([
  "merged",
  "queued",
  "auto-merge",
]);
export type MergeOutcome = typeof MergeOutcomeSchema.Type;

export const MergePullRequestResultSchema = Schema.Struct({
  outcome: MergeOutcomeSchema,
});
export type MergePullRequestResult = typeof MergePullRequestResultSchema.Type;

export const GithubCliReadinessSchema = Schema.Struct({
  installed: Schema.Boolean,
  authed: Schema.Boolean,
});
export type GithubCliReadiness = typeof GithubCliReadinessSchema.Type;

// One open PR offered as a worktree source in the create form. Slimmer
// than PullRequestDetail on purpose: the picker only needs enough to
// recognize the PR and resolve its head, and statusCheckRollup is the
// field that makes `gh pr list` materially slower (same reason the
// sidebar sweep skips it).
const PullRequestCandidateSchema = Schema.Struct({
  number: PullRequestNumberSchema,
  url: UrlSchema,
  title: Schema.String,
  isDraft: Schema.Boolean,
  headRefName: Schema.NonEmptyString,
  authorLogin: Schema.String,
  // Fork heads exist locally only as refs/pull/<n>/head, so the resolver
  // takes a different path for them, and a different set of local
  // branch names.
  fromFork: Schema.Boolean,
  // "owner/repo" of the fork, for the row's label. Null for a same-repo
  // PR, and also for a fork gh can't name any more (deleted fork), which
  // is why fork-ness rides on its own field.
  headRepo: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type PullRequestCandidate = typeof PullRequestCandidateSchema.Type;

// Why gh itself can't be used, independent of any one repo. This is
// what the readiness gate answers.
const GhUnavailableReasonSchema = Schema.Literals([
  "integration-off",
  "gh-missing",
  "gh-signed-out",
]);
export type GhUnavailableReason = typeof GhUnavailableReasonSchema.Type;

// Why the PR source is unavailable for a project: the readiness reasons
// plus the two that are about this repo. Kept as codes rather than prose
// so the renderer owns the wording (and can point at the setting that
// fixes it).
const PullRequestSourceUnavailableSchema = Schema.Literals([
  ...GhUnavailableReasonSchema.literals,
  "no-github-remote",
  "gh-failed",
]);
export type PullRequestSourceUnavailable =
  typeof PullRequestSourceUnavailableSchema.Type;

// "no open PRs" (ok + empty list) is a different answer from "we can't
// ask". The form disables the whole mode for the latter, so the two
// can't collapse into an empty array.
export const PullRequestCandidateListSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    pullRequests: Schema.Array(PullRequestCandidateSchema),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: PullRequestSourceUnavailableSchema,
  }),
]);
export type PullRequestCandidateList =
  typeof PullRequestCandidateListSchema.Type;

export const ResolvePullRequestCheckoutPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  number: PullRequestNumberSchema,
});

export const PullRequestCheckoutRefSchema = Schema.Struct({
  // Local branch the PR head now sits on. Feed it to worktrees.create as
  // `base` with `checkout: true`. From there it's an ordinary
  // check-out-existing-branch create.
  branch: Schema.NonEmptyString,
});
export type PullRequestCheckoutRef = typeof PullRequestCheckoutRefSchema.Type;

export const GithubCliWorktreePullRequestPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  branch: Schema.NonEmptyString,
});

export const GithubCliPullRequestDiffPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  number: PullRequestNumberSchema,
});

export const MergePullRequestPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  number: PullRequestNumberSchema,
  method: MergeMethodSchema,
  // Land the PR together with every open PR under it in its stack,
  // bottom first (shared/pullRequestStack.ts), so the whole stack up
  // to this PR lands in one action. One PR at a time would leave each
  // next PR pointing at a branch that already landed.
  stack: Schema.optional(Schema.Boolean),
});

export const SetPullRequestDraftPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  number: PullRequestNumberSchema,
  draft: Schema.Boolean,
});

export const DisablePullRequestAutoMergePayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  number: PullRequestNumberSchema,
});
