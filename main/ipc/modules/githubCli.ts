import { githubCliContract } from "@shared/ipc/modules/githubCli";
import type { Handlers } from "@shared/ipc/types";
import {
  getPullRequestDiff,
  mergePullRequest,
  setPullRequestDraft,
} from "../../lib/githubCli/actions";
import {
  evictProjectPullRequests,
  getWorktreePullRequest,
  listProjectPullRequests,
} from "../../lib/githubCli/pullRequests";
import { cliAvailable } from "../../electron/cliRunner";
import { mergeViaCli } from "../cliDelegate";
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
    if (cliAvailable()) {
      // The CLI runs the same gh merge and persists lastMergeMethod
      // itself.
      await mergeViaCli(project, number, method);
    } else {
      await mergePullRequest({
        projectId,
        cwd: project.path,
        number,
        method,
      });
    }
    // The merge changes upstream refs (and the sidebar PR cache) --
    // evict once for whichever engine ran so the next read sees the
    // merged state.
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
