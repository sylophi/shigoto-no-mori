import { githubCliContract } from "@shigomori/contracts/modules/githubCli";
import type { EffectHandlers, ViewHandlers } from "@shigomori/contracts/types";
import * as HostPushes from "@host/lib/HostPushes";
import * as Views from "@host/lib/Views";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
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
  noteBranchPullRequest,
} from "@host/lib/githubCli/pullRequests";
import {
  listPullRequestCandidates,
  resolvePullRequestCheckout,
} from "@host/lib/githubCli/pullRequestCheckout";
import type * as Engine from "@host/lib/Engine";
import * as Ops from "@host/lib/engineOps";
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

// The project's PR map moved (a merge, an edit, a page's fresher read):
// its view reads it again.
const pullRequestsMoved = (projectId: string) =>
  HostPushes.push(githubCliContract, "projectPullRequestsRefreshed", {
    projectId,
  });

// The project's PR map as a view: the sweep's, read again as it or a
// call here moves it, and as the GitHub integration is switched.
export const githubCliViews: ViewHandlers<
  typeof githubCliContract,
  | Views.Services
  | GithubCli
  | Engine.Services
  | ChildProcessSpawner.ChildProcessSpawner
> = {
  watchProjectPullRequests: ({ projectId }) =>
    Views.view(
      `githubCli:pullRequests:${projectId}`,
      // Maps don't survive structured clone across IPC, so ship a record.
      () =>
        Effect.flatMap(projectPath(projectId), listProjectPullRequests).pipe(
          Effect.map((map) => Object.fromEntries(map)),
        ),
      Views.either(
        Views.pushed(
          githubCliContract,
          "projectPullRequestsRefreshed",
          (moved) => {
            return moved.projectId === projectId;
          },
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
    Effect.flatMap(projectPath(projectId), (cwd) =>
      publishRepo({ cwd, owner, visibility }),
    ).pipe(Effect.andThen(pullRequestsMoved(projectId))),

  // A page's read of its branch's PR, which moves the project's map when
  // it learned something newer than the sweep.
  worktreePullRequest: ({ projectId, branch }) =>
    Effect.gen(function* () {
      const cwd = yield* projectPath(projectId);
      if (!(yield* (yield* GithubCli).readyForRepo(cwd))) return null;
      const pr = yield* getWorktreePullRequest(cwd, branch);
      if (noteBranchPullRequest(cwd, branch, pr)) {
        yield* pullRequestsMoved(projectId);
      }
      return pr;
    }),

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
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      // The engine runs the gh merge and persists lastMergeMethod itself.
      const result = yield* Ops.mergePullRequest(project, number, method, {
        stack,
      });
      // A landed merge changes upstream refs and the sidebar PR cache:
      // evict so the next read sees the merged state. An armed or queued
      // PR is still open, and the slim map doesn't carry either flag, so
      // the (slow, project-wide) sweep isn't repeated for it.
      if (result.outcome === "merged") {
        evictProjectPullRequests(project.path);
        yield* pullRequestsMoved(projectId);
      }
      return result;
    }),

  pullRequestDiff: ({ projectId, number }) =>
    Effect.flatMap(projectPath(projectId), (cwd) =>
      getPullRequestDiff({ cwd, number }),
    ),

  setPullRequestDraft: ({ projectId, number, draft }) =>
    Effect.flatMap(projectPath(projectId), (cwd) =>
      setPullRequestDraft({ cwd, number, draft }),
    ).pipe(Effect.ensuring(pullRequestsMoved(projectId))),

  pullRequestDraft: ({ projectId, worktreeId }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const worktree = yield* findWorktreeIdentity(project.id, worktreeId, {
        primaryRef: true,
      });
      return yield* getPullRequestDraft({
        cwd: worktree.path,
        projectPath: project.path,
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
        createPullRequest({
          cwd: worktree.path,
          projectPath: project.path,
          ...pr,
        }),
    ).pipe(Effect.ensuring(pullRequestsMoved(projectId))),

  disablePullRequestAutoMerge: ({ projectId, number }) =>
    Effect.flatMap(projectPath(projectId), (cwd) =>
      disablePullRequestAutoMerge({ cwd, number }),
    ).pipe(Effect.ensuring(pullRequestsMoved(projectId))),
} satisfies EffectHandlers<
  typeof githubCliContract,
  unknown,
  | GithubCli
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Engine.Services
  | HostPushes.HostPushes
>;
