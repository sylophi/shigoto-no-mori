import * as Schema from "effect/Schema";
import { push, defineContract, invoke } from "../contract.ts";
import {
  CreatePullRequestPayloadSchema,
  CreatePullRequestResultSchema,
  DiscardAttachmentPayloadSchema,
  DisablePullRequestAutoMergePayloadSchema,
  GithubCliPullRequestDiffPayloadSchema,
  GithubCliReadinessSchema,
  GithubOwnerListSchema,
  GithubRepoListSchema,
  GithubCliWorktreePullRequestPayloadSchema,
  MergePullRequestPayloadSchema,
  MergePullRequestResultSchema,
  ProjectScopedPayloadSchema,
  PullRequestCandidateListSchema,
  PullRequestComparePayloadSchema,
  PullRequestCompareSchema,
  PullRequestDraftSchema,
  PullRequestOptionsSchema,
  StageAttachmentFromUrlPayloadSchema,
  StageAttachmentPayloadSchema,
  StagedAttachmentSchema,
  WorktreeScopedPayloadSchema,
  PullRequestCheckoutRefSchema,
  PullRequestDetailSchema,
  PublishRepoPayloadSchema,
  PullRequestSchema,
  RepoMergeConfigSchema,
  ResolvePullRequestCheckoutPayloadSchema,
  SetPullRequestDraftPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

export const githubCliContract = defineContract(
  "githubCli",
  "host",
  invoke("readiness", VoidSchema, GithubCliReadinessSchema, {
    remote: true,
    gated: false,
  }),
  // Where the add-project dialog can publish a new repository.
  invoke("owners", VoidSchema, GithubOwnerListSchema, {
    remote: true,
    gated: false,
  }),
  // What the add-project dialog offers to clone, as `owner/repo`.
  invoke("repos", VoidSchema, GithubRepoListSchema, {
    remote: true,
    gated: false,
  }),
  // Runs for as long as the push does, under the device's own gh login.
  invoke("publish", PublishRepoPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke(
    "projectPullRequests",
    ProjectScopedPayloadSchema,
    Schema.Record(Schema.String, PullRequestSchema),
    { remote: true, gated: false },
  ),
  invoke(
    "worktreePullRequest",
    GithubCliWorktreePullRequestPayloadSchema,
    Schema.NullOr(PullRequestDetailSchema),
    { remote: true, gated: false },
  ),
  // Open PRs offered as a source in the new-worktree form. Uncached and
  // fired only when the user picks that mode, so opening the form stays
  // free of a gh round trip.
  invoke(
    "pullRequestCandidates",
    ProjectScopedPayloadSchema,
    PullRequestCandidateListSchema,
    { remote: true, gated: false },
  ),
  // Fetches the PR head and lands it on a local branch. Separate from
  // worktrees.create so the create itself still runs through the
  // engine's Worktrees, which knows nothing about PRs.
  invoke(
    "resolvePullRequestCheckout",
    ResolvePullRequestCheckoutPayloadSchema,
    PullRequestCheckoutRefSchema,
    { remote: true, gated: true, grant: "changeCode" },
  ),
  invoke(
    "repoMergeConfig",
    ProjectScopedPayloadSchema,
    Schema.NullOr(RepoMergeConfigSchema),
    { remote: true, gated: false },
  ),
  // The repo's About text, for the home grid's tiles. Null when it has
  // none, isn't on GitHub, or the integration is off. A failed read
  // rejects.
  invoke(
    "repoDescription",
    ProjectScopedPayloadSchema,
    Schema.NullOr(Schema.String),
    { remote: true, gated: false },
  ),
  invoke(
    "mergePullRequest",
    MergePullRequestPayloadSchema,
    MergePullRequestResultSchema,
    {
      tracksProjectUsage: true,
      remote: true,
      gated: true,
      grant: "changeCode",
    },
  ),
  invoke(
    "pullRequestDiff",
    GithubCliPullRequestDiffPayloadSchema,
    Schema.String,
    { remote: true, gated: false },
  ),
  invoke("setPullRequestDraft", SetPullRequestDraftPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // The create pull request dialog's starting point (PullRequestDraftSchema).
  invoke(
    "pullRequestDraft",
    WorktreeScopedPayloadSchema,
    PullRequestDraftSchema,
    {
      remote: true,
      gated: false,
    },
  ),
  // What a PR from the worktree's branch into a base would hold.
  invoke(
    "pullRequestCompare",
    PullRequestComparePayloadSchema,
    PullRequestCompareSchema,
    { remote: true, gated: false },
  ),
  // The people and labels a new PR can name.
  invoke(
    "pullRequestOptions",
    ProjectScopedPayloadSchema,
    PullRequestOptionsSchema,
    { remote: true, gated: false },
  ),
  // Writes a chunk of a file pasted into a new PR's description, kept
  // on the host until the PR is created.
  invoke("stageAttachment", StageAttachmentPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // Fetches an image or video dropped or pasted in as a link.
  invoke(
    "stageAttachmentFromUrl",
    StageAttachmentFromUrlPayloadSchema,
    StagedAttachmentSchema,
    { remote: true, gated: true, grant: "changeCode" },
  ),
  // Drops a staged file taken out of the description.
  invoke("discardAttachment", DiscardAttachmentPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // Pushes the worktree's branch and opens a PR from it.
  invoke(
    "createPullRequest",
    CreatePullRequestPayloadSchema,
    CreatePullRequestResultSchema,
    {
      tracksProjectUsage: true,
      remote: true,
      gated: true,
      grant: "changeCode",
    },
  ),
  // Turns an armed auto-merge off, so the PR waits for a person again.
  invoke(
    "disablePullRequestAutoMerge",
    DisablePullRequestAutoMergePayloadSchema,
    VoidSchema,
    {
      tracksProjectUsage: true,
      remote: true,
      gated: true,
      grant: "changeCode",
    },
  ),
  push("projectPullRequestsRefreshed", ProjectScopedPayloadSchema, {
    remote: true,
  }),
);
