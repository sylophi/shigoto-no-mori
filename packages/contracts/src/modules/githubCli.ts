import * as Schema from "effect/Schema";
import { push, defineContract, invoke, view } from "../contract.ts";
import {
  CreatePullRequestPayloadSchema,
  CreatePullRequestResultSchema,
  DiscardAttachmentPayloadSchema,
  ClosePullRequestPayloadSchema,
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
  invoke("owners", VoidSchema, GithubOwnerListSchema, {
    remote: true,
    gated: false,
  }),
  invoke("repos", VoidSchema, GithubRepoListSchema, {
    remote: true,
    gated: false,
  }),
  // Under the device's own gh login.
  invoke("publish", PublishRepoPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
    busy: "push",
  }),
  // As the background sweep and the pages' reads of a branch's PR leave
  // it.
  view(
    "watchProjectPullRequests",
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
  // Uncached, fired only when the user picks that mode.
  invoke(
    "pullRequestCandidates",
    ProjectScopedPayloadSchema,
    PullRequestCandidateListSchema,
    { remote: true, gated: false },
  ),
  // Apart from worktrees.create, whose engine knows nothing about PRs.
  invoke(
    "resolvePullRequestCheckout",
    ResolvePullRequestCheckoutPayloadSchema,
    PullRequestCheckoutRefSchema,
    { remote: true, gated: true, grant: "changeCode", busy: "fetch" },
  ),
  // Null when gh is not ready or the repo is not on GitHub; a failed
  // read rejects.
  invoke(
    "repoMergeConfig",
    ProjectScopedPayloadSchema,
    Schema.NullOr(RepoMergeConfigSchema),
    { remote: true, gated: false },
  ),
  // Null when there is none, off GitHub, or the integration is off; a
  // failed read rejects.
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
      busy: "merge",
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
  invoke(
    "pullRequestDraft",
    WorktreeScopedPayloadSchema,
    PullRequestDraftSchema,
    {
      remote: true,
      gated: false,
    },
  ),
  invoke(
    "pullRequestCompare",
    PullRequestComparePayloadSchema,
    PullRequestCompareSchema,
    { remote: true, gated: false },
  ),
  invoke(
    "pullRequestOptions",
    ProjectScopedPayloadSchema,
    PullRequestOptionsSchema,
    { remote: true, gated: false },
  ),
  // Kept on the host until the PR is created.
  invoke("stageAttachment", StageAttachmentPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke(
    "stageAttachmentFromUrl",
    StageAttachmentFromUrlPayloadSchema,
    StagedAttachmentSchema,
    { remote: true, gated: true, grant: "changeCode" },
  ),
  invoke("discardAttachment", DiscardAttachmentPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke(
    "createPullRequest",
    CreatePullRequestPayloadSchema,
    CreatePullRequestResultSchema,
    {
      tracksProjectUsage: true,
      remote: true,
      gated: true,
      grant: "changeCode",
      busy: "pullRequest",
    },
  ),
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
  invoke("closePullRequest", ClosePullRequestPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  push("projectPullRequestsRefreshed", ProjectScopedPayloadSchema, {
    remote: true,
  }),
);
