import { Effect } from "effect";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import type { HandlerContext } from "@shared/ipc/transport";
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
import { hostAttempt, hostHandler } from "@host/runtime";

// The project a handler is about, as its first step: an unknown id
// fails with the very UnknownProject findProjectOrThrow throws.
const projectOf = (projectId: string) =>
  hostAttempt(() => findProjectOrThrow(projectId));

export const githubCliHandlers: Handlers<
  typeof githubCliContract,
  HandlerContext
> = {
  readiness: hostHandler(() => hostAttempt(() => getGithubCliReadiness())),

  projectPullRequests: hostHandler(({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      const map = yield* hostAttempt(() =>
        listProjectPullRequests(project.path),
      );
      // Maps don't survive structured clone across IPC, so ship a record.
      return Object.fromEntries(map);
    }),
  ),

  worktreePullRequest: hostHandler(({ projectId, branch }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      return yield* hostAttempt(() =>
        getWorktreePullRequest(project.path, branch),
      );
    }),
  ),

  pullRequestCandidates: hostHandler(({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      return yield* hostAttempt(() => listPullRequestCandidates(project.path));
    }),
  ),

  resolvePullRequestCheckout: hostHandler(({ projectId, number }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      return yield* hostAttempt(() =>
        resolvePullRequestCheckout(project.path, number),
      );
    }),
  ),

  repoMergeConfig: hostHandler(({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      return yield* hostAttempt(() => getRepoMergeConfig(project.path));
    }),
  ),

  mergePullRequest: hostHandler(({ projectId, number, method }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      // One step, so a caller that leaves mid-merge stops waiting, not
      // the eviction that must follow a merge.
      yield* hostAttempt(async () => {
        // The CLI runs the gh merge and persists lastMergeMethod itself.
        await mergeViaCli(project, number, method);
        // The merge changes upstream refs (and the sidebar PR cache).
        // Evict so the next read sees the merged state.
        evictProjectPullRequests(project.path);
      });
      return undefined;
    }),
  ),

  pullRequestDiff: hostHandler(({ projectId, number }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      return yield* hostAttempt(() =>
        getPullRequestDiff({ cwd: project.path, number }),
      );
    }),
  ),

  setPullRequestDraft: hostHandler(({ projectId, number, draft }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      yield* hostAttempt(() =>
        setPullRequestDraft({ cwd: project.path, number, draft }),
      );
      return undefined;
    }),
  ),
};
