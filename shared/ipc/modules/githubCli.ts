import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  GithubCliPullRequestDiffPayloadSchema,
  GithubCliReadinessSchema,
  GithubCliWorktreePullRequestPayloadSchema,
  MergePullRequestPayloadSchema,
  ProjectScopedPayloadSchema,
  PullRequestDetailSchema,
  PullRequestSchema,
  RepoMergeConfigSchema,
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
    z.object({ projectId: z.string() }),
  ),
} as const;

export type GithubCliContract = typeof githubCliContract;
