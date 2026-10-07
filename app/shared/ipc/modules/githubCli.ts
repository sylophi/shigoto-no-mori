import * as Schema from "effect/Schema";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import {
  DisablePullRequestAutoMergePayloadSchema,
  GithubCliPullRequestDiffPayloadSchema,
  GithubCliReadinessSchema,
  GithubCliWorktreePullRequestPayloadSchema,
  MergePullRequestPayloadSchema,
  MergePullRequestResultSchema,
  ProjectScopedPayloadSchema,
  PullRequestCandidateListSchema,
  PullRequestCheckoutRefSchema,
  PullRequestDetailSchema,
  PullRequestSchema,
  RepoMergeConfigSchema,
  ResolvePullRequestCheckoutPayloadSchema,
  SetPullRequestDraftPayloadSchema,
  VoidSchema,
} from "@shared/schemas";

export const githubCliContract = defineContract("host", {
  readiness: invoke(
    "githubCli:readiness",
    VoidSchema,
    GithubCliReadinessSchema,
    {
      remote: true,
      gated: false,
    },
  ),
  projectPullRequests: invoke(
    "githubCli:projectPullRequests",
    ProjectScopedPayloadSchema,
    Schema.Record(Schema.String, PullRequestSchema),
    { remote: true, gated: false },
  ),
  worktreePullRequest: invoke(
    "githubCli:worktreePullRequest",
    GithubCliWorktreePullRequestPayloadSchema,
    Schema.NullOr(PullRequestDetailSchema),
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
    Schema.NullOr(RepoMergeConfigSchema),
    { remote: true, gated: false },
  ),
  // The repo's About text, for the home grid's tiles. Null when it has
  // none, isn't on GitHub, or the integration is off. A failed read
  // rejects.
  repoDescription: invoke(
    "githubCli:repoDescription",
    ProjectScopedPayloadSchema,
    Schema.NullOr(Schema.String),
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
    Schema.String,
    { remote: true, gated: false },
  ),
  setPullRequestDraft: invoke(
    "githubCli:setPullRequestDraft",
    SetPullRequestDraftPayloadSchema,
    VoidSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // Turns an armed auto-merge off, so the PR waits for a person again.
  disablePullRequestAutoMerge: invoke(
    "githubCli:disablePullRequestAutoMerge",
    DisablePullRequestAutoMergePayloadSchema,
    VoidSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  projectPullRequestsRefreshed: broadcast(
    "githubCli:projectPullRequestsRefreshed",
    ProjectScopedPayloadSchema,
    { remote: true },
  ),
});
