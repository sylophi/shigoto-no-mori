import { Schema } from "effect";
import { ProjectScopedPayloadSchema } from "./payloads";
import { NonNegativeInt, PositiveInt } from "./ints";

// zod's z.url(): the value trimmed, then held to what the URL
// constructor parses. The decoded value is the trimmed string.
const UrlSchema = Schema.Trim.check(
  Schema.makeFilter((value: string) => URL.canParse(value), {
    message: "Invalid URL",
  }),
);

export const PullRequestStateSchema = Schema.Literals([
  "OPEN",
  "CLOSED",
  "MERGED",
]);

export const PullRequestSchema = Schema.Struct({
  number: PositiveInt,
  url: UrlSchema,
  title: Schema.String,
  state: PullRequestStateSchema,
  isDraft: Schema.Boolean,
});
export type PullRequest = typeof PullRequestSchema.Type;

// Strip a PullRequestDetail to the slim PullRequest fields used by the
// sidebar's project-wide map. Keep this in lockstep with
// PullRequestSchema. Adding a field there means adding it here too.
export function toSlimPullRequest(pr: PullRequest): PullRequest {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
  };
}

// Field-by-field equality. Used to gate cache write-throughs and sweep
// broadcasts so unchanged PRs don't notify observers. Update if
// PullRequestSchema gains a field that affects the UI.
export function pullRequestsEqual(a: PullRequest, b: PullRequest): boolean {
  return (
    a.number === b.number &&
    a.state === b.state &&
    a.isDraft === b.isDraft &&
    a.title === b.title &&
    a.url === b.url
  );
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

export const PullRequestCheckBucketSchema = Schema.Literals([
  "passed",
  "failing",
  "pending",
  "neutral",
  "skipped",
]);
export type PullRequestCheckBucket = typeof PullRequestCheckBucketSchema.Type;

export const PullRequestCheckSchema = Schema.Struct({
  name: Schema.String,
  bucket: PullRequestCheckBucketSchema,
  url: Schema.optional(UrlSchema),
});
export type PullRequestCheck = typeof PullRequestCheckSchema.Type;

export const PullRequestChecksSummarySchema = Schema.Struct({
  total: NonNegativeInt,
  passed: NonNegativeInt,
  failing: NonNegativeInt,
  pending: NonNegativeInt,
  neutral: NonNegativeInt,
  skipped: NonNegativeInt,
});
export type PullRequestChecksSummary =
  typeof PullRequestChecksSummarySchema.Type;

// Rich projection of the open worktree's PR. Slim PullRequest is kept
// for the project-wide sweep that feeds the sidebar dots, since the
// extra fields make `gh pr list` materially slower.
export const PullRequestDetailSchema = Schema.Struct({
  ...PullRequestSchema.fields,
  mergeState: PullRequestMergeStateSchema,
  // The PR's target branch (e.g. "main"). Shown in the section so the
  // user can see what they're merging into without leaving the app.
  baseRefName: Schema.String,
  // GitHub login of whoever opened the PR. Worktrees may be checked
  // out by teammates' branches, so the author isn't always the local user.
  authorLogin: Schema.String,
  // ISO 8601 timestamp of the PR's last update (commit, comment, etc.).
  updatedAt: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  checks: PullRequestChecksSummarySchema,
  checkList: Schema.Array(PullRequestCheckSchema),
});
export type PullRequestDetail = typeof PullRequestDetailSchema.Type;

const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export const MergeMethodSchema = Schema.Literals(MERGE_METHODS);
export type MergeMethod = typeof MergeMethodSchema.Type;

// Per-repo merge button settings from `gh repo view`. All three may be
// allowed, or only a subset (some teams squash-only). UI hides disabled
// methods rather than disabling them.
export const RepoMergeConfigSchema = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
});
export type RepoMergeConfig = typeof RepoMergeConfigSchema.Type;

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
export const PullRequestCandidateSchema = Schema.Struct({
  number: PositiveInt,
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
export const GhUnavailableReasonSchema = Schema.Literals([
  "integration-off",
  "gh-missing",
  "gh-signed-out",
]);
export type GhUnavailableReason = typeof GhUnavailableReasonSchema.Type;

// Why the PR source is unavailable for a project: the readiness reasons
// plus the two that are about this repo. Kept as codes rather than prose
// so the renderer owns the wording (and can point at the setting that
// fixes it).
export const PullRequestSourceUnavailableSchema = Schema.Literals([
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
  number: PositiveInt,
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
  number: PositiveInt,
});

export const MergePullRequestPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  number: PositiveInt,
  method: MergeMethodSchema,
});

export const SetPullRequestDraftPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  number: PositiveInt,
  draft: Schema.Boolean,
});
