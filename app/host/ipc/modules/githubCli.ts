import { githubCliContract } from "@shared/ipc/modules/githubCli";
import type { Handlers } from "@shared/ipc/types";
import {
  disablePullRequestAutoMerge,
  getPullRequestDiff,
  listGithubOwners,
  listGithubRepos,
  publishRepo,
  setPullRequestDraft,
} from "@host/lib/githubCli/actions";
import {
  evictProjectPullRequests,
  getWorktreePullRequest,
  listProjectPullRequests,
} from "@host/lib/githubCli/pullRequests";
import {
  listPullRequestCandidates,
  resolvePullRequestCheckout,
} from "@host/lib/githubCli/pullRequestCheckout";
import {
  comparePullRequest,
  createPullRequest,
  getPullRequestDraft,
  getPullRequestOptions,
  stageAttachment,
  stageAttachmentFromUrl,
  discardAttachment,
} from "@host/lib/githubCli/newPullRequest";
import { findWorktreeIdentityOrThrow } from "@host/lib/git/worktrees";
import { mergeViaCli } from "../cliDelegate";
import { getGithubCliReadiness } from "@host/lib/githubCli/readiness";
import { getRepoMergeConfig } from "@host/lib/githubCli/repoConfig";
import { getRepoDescription } from "@host/lib/githubCli/repoDescription";
import {
  findProjectAndWorktreeOrThrow,
  findProjectOrThrow,
  findWorktreePathOrThrow,
} from "@host/lib/projects";

export const githubCliHandlers: Handlers<typeof githubCliContract> = {
  readiness: () => getGithubCliReadiness(),

  owners: () => listGithubOwners(),

  repos: () => listGithubRepos(),

  publish: async ({ projectId, owner, visibility }) => {
    const project = await findProjectOrThrow(projectId);
    await publishRepo({ cwd: project.path, owner, visibility });
  },

  projectPullRequests: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    const map = await listProjectPullRequests(project.path);
    // Maps don't survive structured clone across IPC, so ship a record.
    return Object.fromEntries(map);
  },

  worktreePullRequest: async ({ projectId, branch }) => {
    const project = await findProjectOrThrow(projectId);
    return getWorktreePullRequest(project.path, branch);
  },

  pullRequestCandidates: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    return listPullRequestCandidates(project.path);
  },

  resolvePullRequestCheckout: async ({ projectId, number }) => {
    const project = await findProjectOrThrow(projectId);
    return resolvePullRequestCheckout(project.path, number);
  },

  repoMergeConfig: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    return getRepoMergeConfig(project.path);
  },

  repoDescription: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    return getRepoDescription(project.path);
  },

  mergePullRequest: async ({ projectId, number, method, stack }) => {
    const project = await findProjectOrThrow(projectId);
    // The CLI runs the gh merge and persists lastMergeMethod itself.
    const result = await mergeViaCli(project, number, method, { stack });
    // A landed merge changes upstream refs and the sidebar PR cache:
    // evict so the next read sees the merged state. An armed or queued
    // PR is still open, and the slim map doesn't carry either flag, so
    // the (slow, project-wide) sweep isn't repeated for it.
    if (result.outcome === "merged") evictProjectPullRequests(project.path);
    return result;
  },

  pullRequestDiff: async ({ projectId, number }) => {
    const project = await findProjectOrThrow(projectId);
    return getPullRequestDiff({ cwd: project.path, number });
  },

  setPullRequestDraft: async ({ projectId, number, draft }) => {
    const project = await findProjectOrThrow(projectId);
    await setPullRequestDraft({ cwd: project.path, number, draft });
  },

  pullRequestDraft: async ({ projectId, worktreeId }) => {
    const project = await findProjectOrThrow(projectId);
    const worktree = await findWorktreeIdentityOrThrow(project.id, worktreeId, {
      primaryRef: true,
    });
    return getPullRequestDraft({
      cwd: worktree.path,
      projectPath: project.path,
      branch: worktree.branch,
      primaryRef: worktree.primaryRef,
    });
  },

  pullRequestCompare: async ({ projectId, worktreeId, base }) =>
    comparePullRequest(
      await findWorktreePathOrThrow({ projectId, worktreeId }),
      base,
    ),

  pullRequestOptions: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    return getPullRequestOptions(project.path);
  },

  stageAttachment: (chunk) => stageAttachment(chunk),

  stageAttachmentFromUrl: (source) => stageAttachmentFromUrl(source),

  discardAttachment: ({ id }) => discardAttachment(id),

  createPullRequest: async ({ projectId, worktreeId, ...pr }) => {
    const { project, worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    return createPullRequest({
      cwd: worktree.path,
      projectPath: project.path,
      ...pr,
    });
  },

  disablePullRequestAutoMerge: async ({ projectId, number }) => {
    const project = await findProjectOrThrow(projectId);
    await disablePullRequestAutoMerge({ cwd: project.path, number });
  },
};
