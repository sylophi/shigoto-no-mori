import { z } from "zod";

export const PullRequestStateSchema = z.enum(["OPEN", "CLOSED", "MERGED"]);
export type PullRequestState = z.infer<typeof PullRequestStateSchema>;

export const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  state: PullRequestStateSchema,
  isDraft: z.boolean(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

// Strip a PullRequestDetail to the slim PullRequest fields used by the
// sidebar's project-wide map. Keep this in lockstep with
// PullRequestSchema -- adding a field there means adding it here too.
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
// computing" and "gh didn't report it" -- the UI treats both the same.
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
  url: z.string().url().optional(),
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

// Rich projection of the open worktree's PR. Slim PullRequest is kept
// for the project-wide sweep that feeds the sidebar dots, since the
// extra fields make `gh pr list` materially slower.
export const PullRequestDetailSchema = PullRequestSchema.extend({
  mergeState: PullRequestMergeStateSchema,
  // The PR's target branch (e.g. "main"). Shown in the section so the
  // user can see what they're merging into without leaving the app.
  baseRefName: z.string(),
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
});
export type PullRequestDetail = z.infer<typeof PullRequestDetailSchema>;

export const MergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethodSchema>;

// Per-repo merge button settings from `gh repo view`. All three may be
// allowed, or only a subset (some teams squash-only). UI hides disabled
// methods rather than disabling them.
export const RepoMergeConfigSchema = z.object({
  merge: z.boolean(),
  squash: z.boolean(),
  rebase: z.boolean(),
});
export type RepoMergeConfig = z.infer<typeof RepoMergeConfigSchema>;

export const GithubCliReadinessSchema = z.object({
  installed: z.boolean(),
  authed: z.boolean(),
});
export type GithubCliReadiness = z.infer<typeof GithubCliReadinessSchema>;

export const GithubCliProjectPayloadSchema = z.object({
  projectId: z.string().min(1),
});

export const GithubCliWorktreePullRequestPayloadSchema = z.object({
  projectId: z.string().min(1),
  branch: z.string().min(1),
});

export const GithubCliPullRequestDiffPayloadSchema = z.object({
  projectId: z.string().min(1),
  number: z.number().int().positive(),
});

export const MergePullRequestPayloadSchema = z.object({
  projectId: z.string().min(1),
  number: z.number().int().positive(),
  method: MergeMethodSchema,
});
export type MergePullRequestPayload = z.infer<
  typeof MergePullRequestPayloadSchema
>;

export const SetPullRequestDraftPayloadSchema = z.object({
  projectId: z.string().min(1),
  number: z.number().int().positive(),
  draft: z.boolean(),
});
