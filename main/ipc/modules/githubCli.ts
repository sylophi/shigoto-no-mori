import { githubCliContract } from "@shared/ipc/modules/githubCli";
import type { Handlers } from "@shared/ipc/types";
import {
  getPullRequestDiff,
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
import { mergeViaCli } from "../cliDelegate";
import { getGithubCliReadiness } from "@host/lib/githubCli/readiness";
import { getRepoMergeConfig } from "@host/lib/githubCli/repoConfig";
import { findProjectOrThrow } from "@host/lib/projects";

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

  pullRequestCandidates: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return listPullRequestCandidates(project.path);
  },

  resolvePullRequestCheckout: async ({ projectId, number }) => {
    const project = findProjectOrThrow(projectId);
    return resolvePullRequestCheckout(project.path, number);
  },

  repoMergeConfig: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return getRepoMergeConfig(project.path);
  },

  mergePullRequest: async ({ projectId, number, method }) => {
    const project = findProjectOrThrow(projectId);
    // The CLI runs the gh merge and persists lastMergeMethod itself.
    await mergeViaCli(project, number, method);
    // The merge changes upstream refs (and the sidebar PR cache) --
    // evict so the next read sees the merged state.
    evictProjectPullRequests(project.path);
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
