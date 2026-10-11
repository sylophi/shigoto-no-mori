import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import {
  CreatePullRequestPayloadSchema,
  CreatePullRequestResultSchema,
  DiscardAttachmentPayloadSchema,
  DisablePullRequestAutoMergePayloadSchema,
  GithubCliPullRequestDiffPayloadSchema,
  GithubCliReadinessSchema,
  GithubOwnerListSchema,
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
} from "@shared/schemas";

export const githubCliContract = defineContract("host", {
  readiness: invoke("githubCli:readiness", z.void(), GithubCliReadinessSchema, {
    remote: true,
    gated: false,
  }),
  // Where the add-project dialog can publish a new repository.
  owners: invoke("githubCli:owners", z.void(), GithubOwnerListSchema, {
    remote: true,
    gated: false,
  }),
  // What the add-project dialog offers to clone, as `owner/repo`.
  repos: invoke("githubCli:repos", z.void(), z.array(z.string()), {
    remote: true,
    gated: false,
  }),
  // Runs for as long as the push does, under the device's own gh login.
  publish: invoke("githubCli:publish", PublishRepoPayloadSchema, z.void(), {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
  }),
  projectPullRequests: invoke(
    "githubCli:projectPullRequests",
    ProjectScopedPayloadSchema,
    z.record(z.string(), PullRequestSchema),
    { remote: true, gated: false },
  ),
  worktreePullRequest: invoke(
    "githubCli:worktreePullRequest",
    GithubCliWorktreePullRequestPayloadSchema,
    PullRequestDetailSchema.nullable(),
    { remote: true, gated: false },
  ),
  // Open PRs offered as a source in the new-worktree form. Uncached and
  // fired only when the user picks that mode, so opening the form stays
  // free of a gh round trip.
  pullRequestCandidates: invoke(
    "githubCli:pullRequestCandidates",
    ProjectScopedPayloadSchema,
    PullRequestCandidateListSchema,
    { remote: true, gated: false },
  ),
  // Fetches the PR head and lands it on a local branch. Separate from
  // worktrees.create so the create itself still runs through the bundled
  // CLI, which knows nothing about PRs.
  resolvePullRequestCheckout: invoke(
    "githubCli:resolvePullRequestCheckout",
    ResolvePullRequestCheckoutPayloadSchema,
    PullRequestCheckoutRefSchema,
    { remote: true, gated: true },
  ),
  repoMergeConfig: invoke(
    "githubCli:repoMergeConfig",
    ProjectScopedPayloadSchema,
    RepoMergeConfigSchema.nullable(),
    { remote: true, gated: false },
  ),
  // The repo's About text, for the home grid's tiles. Null when it has
  // none, isn't on GitHub, or the integration is off. A failed read
  // rejects.
  repoDescription: invoke(
    "githubCli:repoDescription",
    ProjectScopedPayloadSchema,
    z.string().nullable(),
    { remote: true, gated: false },
  ),
  mergePullRequest: invoke(
    "githubCli:mergePullRequest",
    MergePullRequestPayloadSchema,
    MergePullRequestResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  pullRequestDiff: invoke(
    "githubCli:pullRequestDiff",
    GithubCliPullRequestDiffPayloadSchema,
    z.string(),
    { remote: true, gated: false },
  ),
  setPullRequestDraft: invoke(
    "githubCli:setPullRequestDraft",
    SetPullRequestDraftPayloadSchema,
    z.void(),
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // The create pull request dialog's starting point (PullRequestDraftSchema).
  pullRequestDraft: invoke(
    "githubCli:pullRequestDraft",
    WorktreeScopedPayloadSchema,
    PullRequestDraftSchema,
    { remote: true, gated: false },
  ),
  // What a PR from the worktree's branch into a base would hold.
  pullRequestCompare: invoke(
    "githubCli:pullRequestCompare",
    PullRequestComparePayloadSchema,
    PullRequestCompareSchema,
    { remote: true, gated: false },
  ),
  // The people and labels a new PR can name.
  pullRequestOptions: invoke(
    "githubCli:pullRequestOptions",
    ProjectScopedPayloadSchema,
    PullRequestOptionsSchema,
    { remote: true, gated: false },
  ),
  // Writes a chunk of a file pasted into a new PR's description, kept
  // on the host until the PR is created.
  stageAttachment: invoke(
    "githubCli:stageAttachment",
    StageAttachmentPayloadSchema,
    z.void(),
    { remote: true, gated: true },
  ),
  // Fetches an image or video dropped or pasted in as a link.
  stageAttachmentFromUrl: invoke(
    "githubCli:stageAttachmentFromUrl",
    StageAttachmentFromUrlPayloadSchema,
    StagedAttachmentSchema,
    { remote: true, gated: true },
  ),
  // Drops a staged file taken out of the description.
  discardAttachment: invoke(
    "githubCli:discardAttachment",
    DiscardAttachmentPayloadSchema,
    z.void(),
    { remote: true, gated: true },
  ),
  // Pushes the worktree's branch and opens a PR from it.
  createPullRequest: invoke(
    "githubCli:createPullRequest",
    CreatePullRequestPayloadSchema,
    CreatePullRequestResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // Turns an armed auto-merge off, so the PR waits for a person again.
  disablePullRequestAutoMerge: invoke(
    "githubCli:disablePullRequestAutoMerge",
    DisablePullRequestAutoMergePayloadSchema,
    z.void(),
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  projectPullRequestsRefreshed: broadcast(
    "githubCli:projectPullRequestsRefreshed",
    ProjectScopedPayloadSchema,
    { remote: true },
  ),
});
