import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
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
