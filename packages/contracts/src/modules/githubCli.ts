import * as Schema from "effect/Schema";
import {
  push,
  defineContract,
  invoke,
  view,
  gatedBy,
  trackedCodeChange,
  ungated,
} from "../contract.ts";
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
  { scope: "host", version: 1 },
  invoke("readiness", VoidSchema, GithubCliReadinessSchema, ungated),
  invoke("owners", VoidSchema, GithubOwnerListSchema, ungated),
  invoke("repos", VoidSchema, GithubRepoListSchema, ungated),
  // Under the device's own gh login.
  invoke("publish", PublishRepoPayloadSchema, VoidSchema, {
    ...trackedCodeChange,
    busy: "push",
  }),
  // As the background sweep and the pages' reads of a branch's PR leave
  // it.
  view(
    "watchProjectPullRequests",
    ProjectScopedPayloadSchema,
    Schema.Record(Schema.String, PullRequestSchema),
    ungated,
  ),
  invoke(
    "worktreePullRequest",
    GithubCliWorktreePullRequestPayloadSchema,
    Schema.NullOr(PullRequestDetailSchema),
    ungated,
  ),
  // Uncached, fired only when the user picks that mode.
  invoke(
    "pullRequestCandidates",
    ProjectScopedPayloadSchema,
    PullRequestCandidateListSchema,
    ungated,
  ),
  // Apart from worktrees.create, whose engine knows nothing about PRs.
  invoke(
    "resolvePullRequestCheckout",
    ResolvePullRequestCheckoutPayloadSchema,
    PullRequestCheckoutRefSchema,
    { ...gatedBy("changeCode"), busy: "fetch" },
  ),
  // Null when gh is not ready or the repo is not on GitHub. A failed
  // read rejects.
  invoke(
    "repoMergeConfig",
    ProjectScopedPayloadSchema,
    Schema.NullOr(RepoMergeConfigSchema),
    ungated,
  ),
  // Null when there is none, off GitHub, or the integration is off. A
  // failed read rejects.
  invoke(
    "repoDescription",
    ProjectScopedPayloadSchema,
    Schema.NullOr(Schema.String),
    ungated,
  ),
  invoke(
    "mergePullRequest",
    MergePullRequestPayloadSchema,
    MergePullRequestResultSchema,
    { ...trackedCodeChange, busy: "merge" },
  ),
  invoke(
    "pullRequestDiff",
    GithubCliPullRequestDiffPayloadSchema,
    Schema.String,
    ungated,
  ),
  invoke(
    "setPullRequestDraft",
    SetPullRequestDraftPayloadSchema,
    VoidSchema,
    trackedCodeChange,
  ),
  invoke(
    "pullRequestDraft",
    WorktreeScopedPayloadSchema,
    PullRequestDraftSchema,
    ungated,
  ),
  invoke(
    "pullRequestCompare",
    PullRequestComparePayloadSchema,
    PullRequestCompareSchema,
    ungated,
  ),
  invoke(
    "pullRequestOptions",
    ProjectScopedPayloadSchema,
    PullRequestOptionsSchema,
    ungated,
  ),
  // Kept on the host until the PR is created.
  invoke(
    "stageAttachment",
    StageAttachmentPayloadSchema,
    VoidSchema,
    gatedBy("changeCode"),
  ),
  invoke(
    "stageAttachmentFromUrl",
    StageAttachmentFromUrlPayloadSchema,
    StagedAttachmentSchema,
    gatedBy("changeCode"),
  ),
  invoke(
    "discardAttachment",
    DiscardAttachmentPayloadSchema,
    VoidSchema,
    gatedBy("changeCode"),
  ),
  invoke(
    "createPullRequest",
    CreatePullRequestPayloadSchema,
    CreatePullRequestResultSchema,
    { ...trackedCodeChange, busy: "pullRequest" },
  ),
  invoke(
    "disablePullRequestAutoMerge",
    DisablePullRequestAutoMergePayloadSchema,
    VoidSchema,
    trackedCodeChange,
  ),
  invoke(
    "closePullRequest",
    ClosePullRequestPayloadSchema,
    VoidSchema,
    trackedCodeChange,
  ),
  push("projectPullRequestsRefreshed", ProjectScopedPayloadSchema, {
    remote: true,
  }),
);
