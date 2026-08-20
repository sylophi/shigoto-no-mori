import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  GithubCliPullRequestDiffPayloadSchema,
  GithubCliReadinessSchema,
  GithubCliWorktreePullRequestPayloadSchema,
  MergePullRequestPayloadSchema,
  ProjectScopedPayloadSchema,
  PullRequestCandidateListSchema,
  PullRequestCheckoutRefSchema,
  PullRequestDetailSchema,
  PullRequestSchema,
  RepoMergeConfigSchema,
  ResolvePullRequestCheckoutPayloadSchema,
  SetPullRequestDraftPayloadSchema,
} from "@shared/schemas";

export const githubCliContract = {
  readiness: invoke("githubCli:readiness", z.void(), GithubCliReadinessSchema),
  projectPullRequests: invoke(
    "githubCli:projectPullRequests",
    ProjectScopedPayloadSchema,
    z.record(z.string(), PullRequestSchema),
  ),
  worktreePullRequest: invoke(
    "githubCli:worktreePullRequest",
    GithubCliWorktreePullRequestPayloadSchema,
    PullRequestDetailSchema.nullable(),
  ),
  // Open PRs offered as a source in the new-worktree form. Uncached and
  // fired only when the user picks that mode, so opening the form stays
  // free of a gh round trip.
  pullRequestCandidates: invoke(
    "githubCli:pullRequestCandidates",
    ProjectScopedPayloadSchema,
    PullRequestCandidateListSchema,
  ),
  // Fetches the PR head and lands it on a local branch. Separate from
  // worktrees.create so the create itself still runs through the bundled
  // CLI, which knows nothing about PRs.
  resolvePullRequestCheckout: invoke(
    "githubCli:resolvePullRequestCheckout",
    ResolvePullRequestCheckoutPayloadSchema,
    PullRequestCheckoutRefSchema,
  ),
  repoMergeConfig: invoke(
    "githubCli:repoMergeConfig",
    ProjectScopedPayloadSchema,
    RepoMergeConfigSchema.nullable(),
  ),
  mergePullRequest: invoke(
    "githubCli:mergePullRequest",
    MergePullRequestPayloadSchema,
    z.void(),
    { tracksProjectUsage: true },
  ),
  pullRequestDiff: invoke(
    "githubCli:pullRequestDiff",
    GithubCliPullRequestDiffPayloadSchema,
    z.string(),
  ),
  setPullRequestDraft: invoke(
    "githubCli:setPullRequestDraft",
    SetPullRequestDraftPayloadSchema,
    z.void(),
    { tracksProjectUsage: true },
  ),
  projectPullRequestsRefreshed: broadcast(
    "githubCli:projectPullRequestsRefreshed",
    ProjectScopedPayloadSchema,
  ),
} as const;
