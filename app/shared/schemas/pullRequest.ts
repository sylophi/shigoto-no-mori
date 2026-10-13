import { z } from "zod";
import {
  ProjectScopedPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "./payloads";

export const PullRequestStateSchema = z.enum(["OPEN", "CLOSED", "MERGED"]);

export const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  title: z.string(),
  state: PullRequestStateSchema,
  isDraft: z.boolean(),
  // The branch the PR merges into ("main", or another PR's head when
  // the PR sits in a stack). On the slim shape because the stack is
  // read off the project-wide map: a PR whose base is another PR's
  // head is stacked on it (shared/pullRequestStack.ts).
  baseRefName: z.string(),
  // Whether the PR comes from a fork (isFromThisRepository). Absent
  // from a host on an older build.
  isCrossRepository: z.boolean().optional(),
  // Set on a fork's PR that a branch here was checked out from (the
  // app's PR checkout), which makes it the branch's own. Only a host on
  // this build or later sets it.
  checkedOutFrom: z.literal(true).optional(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

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
  PullRequestSchema.shape,
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
export const PullRequestMergeStateSchema = z.enum([
  "CLEAN",
  "BLOCKED",
  "BEHIND",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);
export type PullRequestMergeState = z.infer<typeof PullRequestMergeStateSchema>;

export const PullRequestCheckBucketSchema = z.enum([
  "passed",
  "failing",
  "pending",
  "neutral",
  "skipped",
]);
export type PullRequestCheckBucket = z.infer<
  typeof PullRequestCheckBucketSchema
>;

export const PullRequestCheckSchema = z.object({
  name: z.string(),
  bucket: PullRequestCheckBucketSchema,
  url: z.url().optional(),
});
export type PullRequestCheck = z.infer<typeof PullRequestCheckSchema>;

export const PullRequestChecksSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failing: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  neutral: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type PullRequestChecksSummary = z.infer<
  typeof PullRequestChecksSummarySchema
>;

export function summarizeChecks(
  checks: PullRequestCheck[],
): PullRequestChecksSummary {
  const summary: PullRequestChecksSummary = {
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
export const PullRequestReviewDecisionSchema = z.enum([
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
]);
export type PullRequestReviewDecision = z.infer<
  typeof PullRequestReviewDecisionSchema
>;

// Where one reviewer stands: their latest submitted review, or
// REQUESTED while they've been asked and haven't given one. Dismissed
// and unsubmitted (PENDING) reviews are left out on the host: neither
// says anything about the PR.
export const PullRequestReviewerStateSchema = z.enum([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "REQUESTED",
]);
export type PullRequestReviewerState = z.infer<
  typeof PullRequestReviewerStateSchema
>;

export const PullRequestReviewsSchema = z.object({
  decision: PullRequestReviewDecisionSchema.nullable(),
  // A user's login, or org/team for a request to a team.
  reviewers: z.array(
    z.object({ login: z.string(), state: PullRequestReviewerStateSchema }),
  ),
});
export type PullRequestReviews = z.infer<typeof PullRequestReviewsSchema>;

export const MergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethodSchema>;

// Rich projection of the open worktree's PR. Slim PullRequest is kept
// for the project-wide sweep that feeds the sidebar dots, since the
// extra fields make `gh pr list` materially slower.
export const PullRequestDetailSchema = PullRequestSchema.extend({
  // The PR's description, markdown as written on GitHub: the worktree
  // page shows it in place of the worktree's own (useWorktreeTitle).
  // Absent from a host on an older build.
  body: z.string().optional(),
  // The body exactly as written, while `body` has its attached images
  // swapped for signed URLs that expire (the host's withSignedImages):
  // what an edit starts from, so it doesn't write those back.
  bodySource: z.string().optional(),
  mergeState: PullRequestMergeStateSchema,
  // The method auto-merge is armed with, or null when it isn't:
  // GitHub merges the PR with it once the base branch's rules are met.
  autoMerge: MergeMethodSchema.nullable(),
  // GitHub login of whoever opened the PR. Worktrees may be checked
  // out by teammates' branches, so the author isn't always the local user.
  authorLogin: z.string(),
  // ISO 8601 timestamp of the PR's last update (commit, comment, etc.).
  updatedAt: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  checks: PullRequestChecksSummarySchema,
  checkList: z.array(PullRequestCheckSchema),
  // Absent from a host on an older build.
  reviews: PullRequestReviewsSchema.optional(),
});
export type PullRequestDetail = z.infer<typeof PullRequestDetailSchema>;

// Per-repo merge button settings from GitHub. All three methods may be
// allowed, or only a subset (some teams squash-only). UI hides disabled
// methods rather than disabling them. autoMerge: the repo lets a PR
// that is waiting on its base branch's rules be armed to merge on its
// own once they are met, which is what the merge button offers then.
export const RepoMergeConfigSchema = z.object({
  merge: z.boolean(),
  squash: z.boolean(),
  rebase: z.boolean(),
  autoMerge: z.boolean(),
});
export type RepoMergeConfig = z.infer<typeof RepoMergeConfigSchema>;

// What became of a merge (cli/cmd_merge.go mergeOutcome): the PR
// landed, a merge queue took it, or auto-merge was armed and GitHub
// lands it once its requirements are met. "merged" leads so a
// schema-derived stub picks it.
export const MergeOutcomeSchema = z.enum(["merged", "queued", "auto-merge"]);
export type MergeOutcome = z.infer<typeof MergeOutcomeSchema>;

export const MergePullRequestResultSchema = z.object({
  outcome: MergeOutcomeSchema,
});
export type MergePullRequestResult = z.infer<
  typeof MergePullRequestResultSchema
>;

// The accounts a new repository can be published under: the signed-in
// user first, then their organizations.
export const GithubOwnerListSchema = z.array(z.string());

// Publishes a project with no remote yet to GitHub as
// `owner/<its folder name>`, and pushes it there. No owner is gh's
// signed-in user. The owner is held to GitHub's own login shape.
export const PublishRepoPayloadSchema = ProjectScopedPayloadSchema.extend({
  owner: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/)
    .optional(),
  visibility: z.enum(["private", "public"]),
});
export type PublishRepoPayload = z.infer<typeof PublishRepoPayloadSchema>;

// One open PR offered as a worktree source in the create form. Slimmer
// than PullRequestDetail on purpose: the picker only needs enough to
// recognize the PR and resolve its head, and statusCheckRollup is the
// field that makes `gh pr list` materially slower (same reason the
// sidebar sweep skips it).
export const PullRequestCandidateSchema = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  title: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string().min(1),
  authorLogin: z.string(),
  // Fork heads exist locally only as refs/pull/<n>/head, so the resolver
  // takes a different path for them, and a different set of local
  // branch names.
  fromFork: z.boolean(),
  // "owner/repo" of the fork, for the row's label. Null for a same-repo
  // PR, and also for a fork gh can't name any more (deleted fork), which
  // is why fork-ness rides on its own field.
  headRepo: z.string().nullable(),
  updatedAt: z.string(),
});
export type PullRequestCandidate = z.infer<typeof PullRequestCandidateSchema>;

// Why gh itself can't be used, independent of any one repo. This is
// what the readiness gate answers.
export const GhUnavailableReasonSchema = z.enum([
  "integration-off",
  "gh-missing",
  "gh-signed-out",
]);
export type GhUnavailableReason = z.infer<typeof GhUnavailableReasonSchema>;

// What gh can do on a device: installed and signed in, and with the
// integration's toggle as well, whether anything may use it (null) or
// why not.
export const GithubCliReadinessSchema = z.object({
  installed: z.boolean(),
  authed: z.boolean(),
  unavailable: GhUnavailableReasonSchema.nullable(),
});
export type GithubCliReadiness = z.infer<typeof GithubCliReadinessSchema>;

// Why the PR source is unavailable for a project: the readiness reasons
// plus the two that are about this repo. Kept as codes rather than prose
// so the renderer owns the wording (and can point at the setting that
// fixes it).
export const PullRequestSourceUnavailableSchema = z.enum([
  ...GhUnavailableReasonSchema.options,
  "no-github-remote",
  "gh-failed",
]);
export type PullRequestSourceUnavailable = z.infer<
  typeof PullRequestSourceUnavailableSchema
>;

// "no open PRs" (ok + empty list) is a different answer from "we can't
// ask". The form disables the whole mode for the latter, so the two
// can't collapse into an empty array.
export const PullRequestCandidateListSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    pullRequests: z.array(PullRequestCandidateSchema),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: PullRequestSourceUnavailableSchema,
  }),
]);
export type PullRequestCandidateList = z.infer<
  typeof PullRequestCandidateListSchema
>;

export const ResolvePullRequestCheckoutPayloadSchema =
  ProjectScopedPayloadSchema.extend({
    number: z.number().int().positive(),
  });

export const PullRequestCheckoutRefSchema = z.object({
  // Local branch the PR head now sits on. Feed it to worktrees.create as
  // `base` with `checkout: true`. From there it's an ordinary
  // check-out-existing-branch create.
  branch: z.string().min(1),
});
export type PullRequestCheckoutRef = z.infer<
  typeof PullRequestCheckoutRefSchema
>;

export const GithubCliWorktreePullRequestPayloadSchema =
  ProjectScopedPayloadSchema.extend({
    branch: z.string().min(1),
  });

export const GithubCliPullRequestDiffPayloadSchema =
  ProjectScopedPayloadSchema.extend({
    number: z.number().int().positive(),
  });

export const MergePullRequestPayloadSchema = ProjectScopedPayloadSchema.extend({
  number: z.number().int().positive(),
  method: MergeMethodSchema,
  // Land the PR together with every open PR under it in its stack,
  // bottom first (shared/pullRequestStack.ts), so the whole stack up
  // to this PR lands in one action. One PR at a time would leave each
  // next PR pointing at a branch that already landed.
  stack: z.boolean().optional(),
});

export const SetPullRequestDraftPayloadSchema =
  ProjectScopedPayloadSchema.extend({
    number: z.number().int().positive(),
    draft: z.boolean(),
  });

// What the create pull request dialog starts from, read once as it
// opens. The base a stacked branch belongs on (the nearest branch below
// it with an open PR of its own), null for the primary branch. The
// title and body gh's --fill would give the branch's commits against
// that base. And the repo's PR template, null without one.
export const PullRequestDraftSchema = z.object({
  suggestedBase: z.string().nullable(),
  fill: z.object({ title: z.string(), body: z.string() }),
  template: z.string().nullable(),
});
export type PullRequestDraft = z.infer<typeof PullRequestDraftSchema>;

// What a PR into `base` would hold: how many commits the branch has
// since it left the base, and what they change together. The base is a
// branch name, compared at its remote-tracking ref when there is one.
export const PullRequestComparePayloadSchema =
  WorktreeScopedPayloadSchema.extend({
    base: z.string().min(1),
  });
export const PullRequestCompareSchema = z.object({
  commits: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type PullRequestCompare = z.infer<typeof PullRequestCompareSchema>;

// Who and what a new PR can name, from the repo: the signed-in user,
// the people it can be assigned to (reviewers are picked from the same
// list, less the viewer), and its labels.
export const PullRequestOptionsSchema = z.object({
  viewer: z.string(),
  people: z.array(z.object({ login: z.string(), name: z.string().nullable() })),
  labels: z.array(
    z.object({
      name: z.string(),
      // Hex without the hash, as GitHub stores it.
      color: z.string(),
      description: z.string().nullable(),
    }),
  ),
});
export type PullRequestOptions = z.infer<typeof PullRequestOptionsSchema>;

// A file the description refers to as `./<name>`, staged on the host a
// chunk at a time as it is pasted in (stageAttachment), and uploaded
// by gh's --attach when the PR is created. The id is the renderer's.
export const AttachmentIdSchema = z.string().regex(/^[0-9a-f]{16}$/);
export const AttachmentNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);

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
export const StageAttachmentFromUrlPayloadSchema = z.object({
  id: AttachmentIdSchema,
  stem: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  url: z.url({ protocol: /^https?$/ }),
});
export const StagedAttachmentSchema = z.object({
  name: AttachmentNameSchema,
  type: z.string(),
});
export type StagedAttachment = z.infer<typeof StagedAttachmentSchema>;

// One chunk of an attachment, its bytes as base64. Chunks go in order,
// each at the offset the ones before it end at, small enough that a
// peer's request frame (1 MiB) holds one.
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;
export const StageAttachmentPayloadSchema = z.object({
  id: AttachmentIdSchema,
  name: AttachmentNameSchema,
  offset: z.number().int().nonnegative(),
  base64: z.string().max(Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4),
});

export const DiscardAttachmentPayloadSchema = z.object({
  id: AttachmentIdSchema,
});

// A new PR from the worktree's branch into `base`, with GitHub's own
// limits on the title and body (cli/cmd_describe.go). Each attachment
// must be staged in full, and is referenced in the body as
// `./<name>`.
export const CreatePullRequestPayloadSchema =
  WorktreeScopedPayloadSchema.extend({
    base: z.string().min(1),
    title: z.string().min(1).max(256),
    body: z.string().max(65536),
    draft: z.boolean(),
    reviewers: z.array(z.string().min(1)),
    assignees: z.array(z.string().min(1)),
    labels: z.array(z.string().min(1)),
    attachments: z.array(
      z.object({ id: AttachmentIdSchema, name: AttachmentNameSchema }),
    ),
  });
export type CreatePullRequestPayload = z.infer<
  typeof CreatePullRequestPayloadSchema
>;

// The new PR's URL, and what went wrong after it was made (an
// attachment that didn't upload), null when nothing did.
export const CreatePullRequestResultSchema = z.object({
  url: z.url(),
  warning: z.string().nullable(),
});
export type CreatePullRequestResult = z.infer<
  typeof CreatePullRequestResultSchema
>;

export const DisablePullRequestAutoMergePayloadSchema =
  ProjectScopedPayloadSchema.extend({
    number: z.number().int().positive(),
  });
