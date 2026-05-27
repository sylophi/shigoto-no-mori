import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  GithubCliProjectPayloadSchema,
  GithubCliPullRequestDiffPayloadSchema,
  GithubCliReadinessSchema,
  GithubCliWorktreePullRequestPayloadSchema,
  MergePullRequestPayloadSchema,
  PullRequestDetailSchema,
  PullRequestSchema,
  RepoMergeConfigSchema,
  SetPullRequestDraftPayloadSchema,
} from "@shared/schemas";

export const githubCliContract = {
  readiness: invoke("githubCli:readiness", z.void(), GithubCliReadinessSchema),
  projectPullRequests: invoke(
    "githubCli:projectPullRequests",
    GithubCliProjectPayloadSchema,
    z.record(z.string(), PullRequestSchema),
  ),
  worktreePullRequest: invoke(
    "githubCli:worktreePullRequest",
    GithubCliWorktreePullRequestPayloadSchema,
    PullRequestDetailSchema.nullable(),
  ),
  repoMergeConfig: invoke(
    "githubCli:repoMergeConfig",
    GithubCliProjectPayloadSchema,
    RepoMergeConfigSchema.nullable(),
  ),
  mergePullRequest: invoke(
    "githubCli:mergePullRequest",
    MergePullRequestPayloadSchema,
    z.void(),
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
  ),
  projectPullRequestsRefreshed: broadcast(
    "githubCli:projectPullRequestsRefreshed",
    z.object({ projectId: z.string() }),
  ),
} as const;

export type GithubCliContract = typeof githubCliContract;

const client = buildClient(githubCliContract);

export const githubCli = {
  readiness: () => client.readiness(),
  projectPullRequests: client.projectPullRequests,
  worktreePullRequest: client.worktreePullRequest,
  repoMergeConfig: client.repoMergeConfig,
  mergePullRequest: client.mergePullRequest,
  pullRequestDiff: client.pullRequestDiff,
  setPullRequestDraft: client.setPullRequestDraft,
  onProjectPullRequestsRefreshed: client.projectPullRequestsRefreshed,
} as const;
