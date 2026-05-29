import { githubCliContract } from "@shared/ipc/modules/githubCli";
import type { Handlers } from "@shared/ipc/types";
import {
  getPullRequestDiff,
  mergePullRequest,
  setPullRequestDraft,
} from "../../lib/githubCli/actions";
import {
  getWorktreePullRequest,
  listProjectPullRequests,
} from "../../lib/githubCli/pullRequests";
import { getGithubCliReadiness } from "../../lib/githubCli/readiness";
import { getRepoMergeConfig } from "../../lib/githubCli/repoConfig";
import { findProjectOrThrow } from "../../lib/projects";

export const githubCliHandlers: Handlers<typeof githubCliContract> = {
  readiness: () => getGithubCliReadiness(),

  projectPullRequests: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    const map = await listProjectPullRequests(project.path);
    // Maps don't survive structured clone across IPC -- ship as a record.
    return Object.fromEntries(map);
  },

  worktreePullRequest: async ({ projectId, branch }) => {
    const project = findProjectOrThrow(projectId);
    return getWorktreePullRequest(project.path, branch);
  },

  repoMergeConfig: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return getRepoMergeConfig(project.path);
  },

  mergePullRequest: async ({ projectId, number, method }) => {
    const project = findProjectOrThrow(projectId);
    await mergePullRequest({
      projectId,
      cwd: project.path,
      number,
      method,
    });
  },

  pullRequestDiff: async ({ projectId, number }) => {
    const project = findProjectOrThrow(projectId);
    return getPullRequestDiff({ cwd: project.path, number });
  },

  setPullRequestDraft: async ({ projectId, number, draft }) => {
    const project = findProjectOrThrow(projectId);
    await setPullRequestDraft({ cwd: project.path, number, draft });
  },
};
