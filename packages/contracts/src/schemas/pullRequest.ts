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
  // head is stacked on it (pullRequestStack.ts).
  baseRefName: Schema.String,
  // Whether the PR comes from a fork (isFromThisRepository). Absent
  // from a host on an older build.
  isCrossRepository: Schema.optional(Schema.Boolean),
  // Set on a fork's PR that a branch here was checked out from (the
  // app's PR checkout), which makes it the branch's own. Only a host on
  // this build or later sets it.
  checkedOutFrom: Schema.optional(Schema.Literal(true)),
});
export type PullRequest = typeof PullRequestSchema.Type;

// Whether a PR comes from this repository. GitHub matches a branch
// name across every fork, so a PR from a fork may be a stranger's
// branch of the same name, and nothing found by branch takes one for
// the branch's own, unless the branch was checked out from it
// (isBranchsPullRequest).
export function isFromThisRepository(
  pr: Pick<PullRequest, "isCrossRepository">,
): boolean {
  return pr.isCrossRepository !== true;
}

// Whether a PR found by its head branch's name is the branch's own:
// one from this repository, or the fork's PR the branch was checked
// out from.
export function isBranchsPullRequest(
  pr: Pick<PullRequest, "isCrossRepository" | "checkedOutFrom">,
): boolean {
  return isFromThisRepository(pr) || pr.checkedOutFrom === true;
}

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
  // The body exactly as written, while `body` has its attached images
  // swapped for signed URLs that expire (the host's withSignedImages):
  // what an edit starts from, so it doesn't write those back.
  bodySource: Schema.optional(Schema.String),
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

// What became of a merge (the engine's Landing.ts): the PR
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

// The accounts a new repository can be published under: the signed-in
// user first, then their organizations.
export const GithubOwnerListSchema = Schema.Array(Schema.String);

// What the add-project dialog offers to clone, as `owner/repo`.
export const GithubRepoListSchema = Schema.Array(Schema.String);

// Publishes a project with no remote yet to GitHub as
// `owner/<its folder name>`, and pushes it there. No owner is gh's
// signed-in user. The owner is held to GitHub's own login shape.
export const PublishRepoPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  owner: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*$/)),
  ),
  visibility: Schema.Literals(["private", "public"]),
});
export type PublishRepoPayload = typeof PublishRepoPayloadSchema.Type;

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

// What gh can do on a device: installed and signed in, and with the
// integration's toggle as well, whether anything may use it (null) or
// why not.
export const GithubCliReadinessSchema = Schema.Struct({
  installed: Schema.Boolean,
  authed: Schema.Boolean,
  unavailable: Schema.NullOr(GhUnavailableReasonSchema),
});
export type GithubCliReadiness = typeof GithubCliReadinessSchema.Type;

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
  // bottom first (pullRequestStack.ts), so the whole stack up
  // to this PR lands in one action. One PR at a time would leave each
  // next PR pointing at a branch that already landed.
  stack: Schema.optional(Schema.Boolean),
});

export const SetPullRequestDraftPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  number: PullRequestNumberSchema,
  draft: Schema.Boolean,
});

// What the create pull request dialog starts from, read once as it
// opens. The base a stacked branch belongs on (the nearest branch below
// it with an open PR of its own), null for the primary branch. The
// title and body gh's --fill would give the branch's commits against
// that base. And the repo's PR template, null without one.
export const PullRequestDraftSchema = Schema.Struct({
  suggestedBase: Schema.NullOr(Schema.String),
  fill: Schema.Struct({ title: Schema.String, body: Schema.String }),
  template: Schema.NullOr(Schema.String),
});
export type PullRequestDraft = typeof PullRequestDraftSchema.Type;

// What a PR into `base` would hold: how many commits the branch has
// since it left the base, and what they change together. The base is a
// branch name, compared at its remote-tracking ref when there is one.
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

// Who and what a new PR can name, from the repo: the signed-in user,
// the people it can be assigned to (reviewers are picked from the same
// list, less the viewer), and its labels.
export const PullRequestOptionsSchema = Schema.Struct({
  viewer: Schema.String,
  people: Schema.Array(
    Schema.Struct({ login: Schema.String, name: Schema.NullOr(Schema.String) }),
  ),
  labels: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      // Hex without the hash, as GitHub stores it.
      color: Schema.String,
      description: Schema.NullOr(Schema.String),
    }),
  ),
});
export type PullRequestOptions = typeof PullRequestOptionsSchema.Type;

// A file the description refers to as `./<name>`, staged on the host a
// chunk at a time as it is pasted in (stageAttachment), and uploaded
// by gh's --attach when the PR is created. The id is the renderer's.
export const AttachmentIdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{16}$/),
);
export const AttachmentNameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
);

// What gh's --attach uploads, by the extension it reads the type from
// (cli/cli internal/attachments/userasset.go), and how big: GitHub's
// limit for an image, and gh's for a video (the plan decides the rest).
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

// An image or video on the web, fetched by the host into the staging
// folder like a pasted file, so the PR keeps its own copy on GitHub.
// Its name is `<stem>.<extension of the type it came as>`, which the
// host answers with.
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

// One chunk of an attachment, its bytes as base64. Chunks go in order,
// each at the offset the ones before it end at, small enough that a
// peer's call carries one comfortably.
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

// A new PR from the worktree's branch into `base`, with GitHub's own
// limits on the title and body. Each attachment must be staged in full,
// and is referenced in the body as `./<name>`.
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

// The new PR's URL, and what went wrong after it was made (an
// attachment that didn't upload), null when nothing did.
export const CreatePullRequestResultSchema = Schema.Struct({
  url: UrlSchema,
  warning: Schema.NullOr(Schema.String),
});
export type CreatePullRequestResult = typeof CreatePullRequestResultSchema.Type;

export const DisablePullRequestAutoMergePayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  number: PullRequestNumberSchema,
});
