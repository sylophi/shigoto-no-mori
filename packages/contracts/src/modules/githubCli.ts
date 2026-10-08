import * as Schema from "effect/Schema";
import { broadcast, defineContract, invoke } from "../contract.ts";
import {
  DisablePullRequestAutoMergePayloadSchema,
  GithubCliPullRequestDiffPayloadSchema,
  GithubCliReadinessSchema,
  GithubOwnerListSchema,
  GithubCliWorktreePullRequestPayloadSchema,
  MergePullRequestPayloadSchema,
  MergePullRequestResultSchema,
  ProjectScopedPayloadSchema,
  PullRequestCandidateListSchema,
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
  // worktrees.create so the create itself still runs through the bundled
  // CLI, which knows nothing about PRs.
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
  broadcast("projectPullRequestsRefreshed", ProjectScopedPayloadSchema, {
    remote: true,
  }),
);
