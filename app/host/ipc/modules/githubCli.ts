import { githubCliContract } from "@shigomori/contracts/modules/githubCli";
import type { EffectHandlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/Views";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  closePullRequest,
  disablePullRequestAutoMerge,
  getPullRequestDiff,
  listGithubOwners,
  listGithubRepos,
  mergePullRequest,
  publishRepo,
  setPullRequestDraft,
} from "@host/lib/githubCli/actions";
import * as PullRequestMaps from "@host/lib/githubCli/PullRequestMaps";
import {
  listPullRequestCandidates,
  resolvePullRequestCheckout,
} from "@host/lib/githubCli/pullRequestCheckout";
import type * as Engine from "@host/lib/Engine";
import { GithubCli } from "@host/lib/githubCli/GithubCli";
import {
  findProject,
  findProjectAndWorktree,
  findWorktreePath,
} from "@host/lib/projects";
import {
  comparePullRequest,
  createPullRequest,
  discardAttachment,
  getPullRequestDraft,
  getPullRequestOptions,
  stageAttachment,
  stageAttachmentFromUrl,
} from "@host/lib/githubCli/newPullRequest";
import { findWorktreeIdentity } from "@host/lib/projects";

const projectPath = (projectId: string) =>
  Effect.map(findProject(projectId), (project) => project.path);

const maps = PullRequestMaps.PullRequestMaps;

// The project's PR map as a view: read again as the map announces a
// change, and as the GitHub integration is switched.
export const githubCliViews: ViewHandlers<
  typeof githubCliContract,
  Views.Services | PullRequestMaps.PullRequestMaps | Engine.Services
> = {
  watchProjectPullRequests: ({ projectId }) =>
    Views.view(
      `githubCli:pullRequests:${projectId}`,
      // Maps don't survive structured clone across IPC, so ship a record.
      () =>
        Effect.gen(function* () {
          const project = yield* findProject(projectId);
          return Object.fromEntries(yield* (yield* maps).get(project));
        }),
      Views.either(
        Views.pushed(
          githubCliContract,
          "projectPullRequestsRefreshed",
          (moved) => moved.projectId === projectId,
        ),
        Views.wrote("device_config"),
      ),
    ),
};

export const githubCliHandlers = {
  readiness: () => Effect.flatMap(GithubCli, (cli) => cli.readiness),

  owners: () => listGithubOwners(),

  repos: () => listGithubRepos(),

  publish: ({ projectId, owner, visibility }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      publishRepo({ project, owner, visibility }),
    ),

  worktreePullRequest: ({ projectId, branch }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      Effect.flatMap(maps, (it) => it.branchPullRequest(project, branch)),
    ),

  pullRequestCandidates: ({ projectId }) =>
    Effect.flatMap(projectPath(projectId), listPullRequestCandidates),

  resolvePullRequestCheckout: ({ projectId, number }) =>
    Effect.flatMap(projectPath(projectId), (cwd) =>
      resolvePullRequestCheckout(cwd, number),
    ),

  repoMergeConfig: ({ projectId }) =>
    Effect.flatMap(projectPath(projectId), (cwd) =>
      Effect.flatMap(GithubCli, (cli) => cli.mergeConfig(cwd)),
    ),

  repoDescription: ({ projectId }) =>
    Effect.flatMap(projectPath(projectId), (cwd) =>
      Effect.flatMap(GithubCli, (cli) => cli.description(cwd)),
    ),

  mergePullRequest: ({ projectId, number, method, stack }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      mergePullRequest(project, number, method, { stack }),
    ),

  pullRequestDiff: ({ projectId, number }) =>
    Effect.flatMap(projectPath(projectId), (cwd) =>
      getPullRequestDiff({ cwd, number }),
    ),

  setPullRequestDraft: ({ projectId, number, draft }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      setPullRequestDraft({ project, number, draft }),
    ),

  pullRequestDraft: ({ projectId, worktreeId }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const worktree = yield* findWorktreeIdentity(project.id, worktreeId, {
        primaryRef: true,
      });
      return yield* getPullRequestDraft({
        cwd: worktree.path,
        project,
        branch: worktree.branch,
        primaryRef: worktree.primaryRef,
      });
    }),

  pullRequestCompare: ({ projectId, worktreeId, base }) =>
    Effect.flatMap(findWorktreePath({ projectId, worktreeId }), (cwd) =>
      comparePullRequest(cwd, base),
    ),

  pullRequestOptions: ({ projectId }) =>
    Effect.flatMap(projectPath(projectId), getPullRequestOptions),

  stageAttachment: (chunk) => stageAttachment(chunk),

  stageAttachmentFromUrl: (source) => stageAttachmentFromUrl(source),

  discardAttachment: ({ id }) => discardAttachment(id),

  createPullRequest: ({ projectId, worktreeId, ...pr }) =>
    Effect.flatMap(
      findProjectAndWorktree(projectId, worktreeId),
      ({ project, worktree }) =>
        createPullRequest({ cwd: worktree.path, project, ...pr }),
    ),

  disablePullRequestAutoMerge: ({ projectId, number }) =>
    Effect.flatMap(projectPath(projectId), (cwd) =>
      disablePullRequestAutoMerge({ cwd, number }),
    ),

  closePullRequest: ({ projectId, number, comment }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      closePullRequest(project, number, comment),
    ),
} satisfies EffectHandlers<
  typeof githubCliContract,
  unknown,
  | GithubCli
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Engine.Services
  | PullRequestMaps.PullRequestMaps
>;
