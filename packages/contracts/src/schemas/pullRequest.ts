import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { isWebUrl } from "../predicates/webUrl.ts";
import {
  ProjectScopedPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "./payloads.ts";

const PullRequestNumberSchema = Schema.Int.check(Schema.isGreaterThan(0));

const isUrl = (value: string): boolean => {
  try {
    return Boolean(new URL(value));
  } catch {
    return false;
  }
};

// GitHub and CI integrations can write whitespace, even tabs and
// newlines inside.
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
  // On the slim shape because stacks are read off the project's map.
  baseRefName: Schema.String,
  isCrossRepository: Schema.optional(Schema.Boolean),
  // A fork's PR a branch here was checked out from, which makes it the
  // branch's own.
  checkedOutFrom: Schema.optional(Schema.Literal(true)),
});
export type PullRequest = typeof PullRequestSchema.Type;

// GitHub matches a branch name across every fork, so a fork's PR found
// by branch may be a stranger's branch of the same name.
export function isFromThisRepository(
  pr: Pick<PullRequest, "isCrossRepository">,
): boolean {
  return pr.isCrossRepository !== true;
}

export function isBranchsPullRequest(
  pr: Pick<PullRequest, "isCrossRepository" | "checkedOutFrom">,
): boolean {
  return isFromThisRepository(pr) || pr.checkedOutFrom === true;
}

// Read off the schema, so a field added there is carried and compared.
const PULL_REQUEST_KEYS = Object.keys(
  PullRequestSchema.fields,
) as (keyof PullRequest)[];

export function toSlimPullRequest(pr: PullRequest): PullRequest {
  return Object.fromEntries(
    PULL_REQUEST_KEYS.map((key) => [key, pr[key]]),
  ) as PullRequest;
}

export function pullRequestsEqual(a: PullRequest, b: PullRequest): boolean {
  return PULL_REQUEST_KEYS.every((key) => a[key] === b[key]);
}

// `pr` null: the branch has none.
export function matchesMapEntry(
  pr: PullRequest | null,
  entry: PullRequest | undefined,
): boolean {
  return pr === null
    ? entry === undefined
    : entry !== undefined && pullRequestsEqual(pr, entry);
}

// GraphQL's mergeStateStatus. UNKNOWN also covers "still computing".
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

// GraphQL's reviewDecision; null when the base has no required-review
// rule.
export const PullRequestReviewDecisionSchema = Schema.Literals([
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
]);

// A reviewer's latest submitted review, or REQUESTED. Dismissed and
// pending reviews are left out.
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
  // org/team for a team.
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

// The project-wide sweep stays slim: these fields make `gh pr list`
// materially slower.
export const PullRequestDetailSchema = Schema.Struct({
  ...PullRequestSchema.fields,
  body: Schema.optional(Schema.String),
  // `body` has its images swapped for expiring signed URLs; an edit
  // starts from this, so it doesn't write those back.
  bodySource: Schema.optional(Schema.String),
  mergeState: PullRequestMergeStateSchema,
  autoMerge: Schema.NullOr(MergeMethodSchema),
  authorLogin: Schema.String,
  // ISO 8601.
  updatedAt: Schema.String,
  additions: Schema.Natural,
  deletions: Schema.Natural,
  changedFiles: Schema.Natural,
  checks: PullRequestChecksSummarySchema,
  checkList: Schema.Array(PullRequestCheckSchema),
  reviews: Schema.optional(PullRequestReviewsSchema),
});
export type PullRequestDetail = typeof PullRequestDetailSchema.Type;

export const RepoMergeConfigSchema = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
  autoMerge: Schema.Boolean,
});
export type RepoMergeConfig = typeof RepoMergeConfigSchema.Type;

// "merged" leads so a schema-derived stub picks it.
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

// The signed-in user first, then their organizations.
export const GithubOwnerListSchema = Schema.Array(Schema.String);

// `owner/repo`.
export const GithubRepoListSchema = Schema.Array(Schema.String);

// As `owner/<folder name>`; no owner is gh's signed-in user.
export const PublishRepoPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  owner: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*$/)),
  ),
  visibility: Schema.Literals(["private", "public"]),
});
export type PublishRepoPayload = typeof PublishRepoPayloadSchema.Type;

// Slim on purpose: statusCheckRollup makes `gh pr list` materially
// slower.
const PullRequestCandidateSchema = Schema.Struct({
  number: PullRequestNumberSchema,
  url: UrlSchema,
  title: Schema.String,
  isDraft: Schema.Boolean,
  headRefName: Schema.NonEmptyString,
  authorLogin: Schema.String,
  // Fork heads exist locally only as refs/pull/<n>/head.
  fromFork: Schema.Boolean,
  // Null for a same-repo PR and for a deleted fork, hence `fromFork`.
  headRepo: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type PullRequestCandidate = typeof PullRequestCandidateSchema.Type;

const GhUnavailableReasonSchema = Schema.Literals([
  "integration-off",
  "gh-missing",
  "gh-signed-out",
]);
export type GhUnavailableReason = typeof GhUnavailableReasonSchema.Type;

// unavailable: null when anything may use it.
export const GithubCliReadinessSchema = Schema.Struct({
  installed: Schema.Boolean,
  authed: Schema.Boolean,
  unavailable: Schema.NullOr(GhUnavailableReasonSchema),
});
export type GithubCliReadiness = typeof GithubCliReadinessSchema.Type;

const PullRequestSourceUnavailableSchema = Schema.Literals([
  ...GhUnavailableReasonSchema.literals,
  "no-github-remote",
  "gh-failed",
]);
export type PullRequestSourceUnavailable =
  typeof PullRequestSourceUnavailableSchema.Type;

// "No open PRs" and "can't ask" must not collapse into an empty array.
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
  // For worktrees.create's `base`, with `checkout: true`.
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
  // With every open PR under it, bottom first: one at a time would leave
  // each next PR pointing at a branch that already landed.
  stack: Schema.optional(Schema.Boolean),
});

export const SetPullRequestDraftPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  number: PullRequestNumberSchema,
  draft: Schema.Boolean,
});

// suggestedBase: the nearest branch below with an open PR, null for the
// primary. fill: what gh's --fill would give.
export const PullRequestDraftSchema = Schema.Struct({
  suggestedBase: Schema.NullOr(Schema.String),
  fill: Schema.Struct({ title: Schema.String, body: Schema.String }),
  template: Schema.NullOr(Schema.String),
});
export type PullRequestDraft = typeof PullRequestDraftSchema.Type;

// `base` is compared at its remote-tracking ref when there is one.
export const PullRequestComparePayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  base: Schema.NonEmptyString,
});
export const PullRequestCompareSchema = Schema.Struct({
  commits: Schema.Natural,
  files: Schema.Natural,
  additions: Schema.Natural,
  deletions: Schema.Natural,
});
export type PullRequestCompare = typeof PullRequestCompareSchema.Type;

// Reviewers come from `people`, less the viewer.
export const PullRequestOptionsSchema = Schema.Struct({
  viewer: Schema.String,
  people: Schema.Array(
    Schema.Struct({ login: Schema.String, name: Schema.NullOr(Schema.String) }),
  ),
  labels: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      // Hex without the hash.
      color: Schema.String,
      description: Schema.NullOr(Schema.String),
    }),
  ),
});
export type PullRequestOptions = typeof PullRequestOptionsSchema.Type;

// Referred to in the body as `./<name>`, staged on the host, uploaded by
// gh's --attach.
export const AttachmentIdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{16}$/),
);
export const AttachmentNameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
);

// gh's --attach reads the type from the extension
// (cli/cli internal/attachments/userasset.go).
export const ATTACHMENT_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
export const ATTACHMENT_VIDEO_EXTENSIONS: Readonly<Record<string, string>> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};
export const MAX_ATTACHMENT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_VIDEO_BYTES = 100 * 1024 * 1024;

// Fetched into staging, so the PR keeps its own copy on GitHub. Named
// `<stem>.<extension of the type it came as>`.
export const StageAttachmentFromUrlPayloadSchema = Schema.Struct({
  id: AttachmentIdSchema,
  stem: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  ),
  url: Schema.String.check(
    Schema.makeFilter((url: string) => isWebUrl(url) || "Not a web URL"),
  ),
});
export const StagedAttachmentSchema = Schema.Struct({
  name: AttachmentNameSchema,
  type: Schema.String,
});
export type StagedAttachment = typeof StagedAttachmentSchema.Type;

// Chunks go in order, small enough for one peer call.
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;
export const StageAttachmentPayloadSchema = Schema.Struct({
  id: AttachmentIdSchema,
  name: AttachmentNameSchema,
  offset: Schema.Natural,
  base64: Schema.String.check(
    Schema.isMaxLength(Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4),
  ),
});

export const DiscardAttachmentPayloadSchema = Schema.Struct({
  id: AttachmentIdSchema,
});

// GitHub's limits on the title and body.
export const CreatePullRequestPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  base: Schema.NonEmptyString,
  title: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  body: Schema.String.check(Schema.isMaxLength(65536)),
  draft: Schema.Boolean,
  reviewers: Schema.Array(Schema.NonEmptyString),
  assignees: Schema.Array(Schema.NonEmptyString),
  labels: Schema.Array(Schema.NonEmptyString),
  attachments: Schema.Array(
    Schema.Struct({ id: AttachmentIdSchema, name: AttachmentNameSchema }),
  ),
});
export type CreatePullRequestPayload =
  typeof CreatePullRequestPayloadSchema.Type;

// warning: what went wrong after the PR was made.
export const CreatePullRequestResultSchema = Schema.Struct({
  url: UrlSchema,
  warning: Schema.NullOr(Schema.String),
});
export type CreatePullRequestResult = typeof CreatePullRequestResultSchema.Type;

export const DisablePullRequestAutoMergePayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  number: PullRequestNumberSchema,
});
