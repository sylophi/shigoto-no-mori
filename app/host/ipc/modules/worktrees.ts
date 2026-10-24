import * as EngineWorktrees from "@shigomori/engine/Worktrees";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import * as Effect from "effect/Effect";
import * as GitWatcher from "@host/lib/GitWatcher";
import * as HostPushes from "@host/lib/HostPushes";
import type { ScriptChanges } from "@host/lib/scripts/ScriptChanges";
import type { PeerReach } from "@host/ipc/PeerReach";
import * as Schedule from "effect/Schedule";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { HandlerContext } from "@shared/ipc/transport";
import type { ViewHandlers } from "@shigomori/contracts/types";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/Views";
import { gitContract } from "@shigomori/contracts/modules/git";
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import type { Project } from "@shigomori/contracts/schemas";
import * as Git from "@shigomori/engine/Git";
import type { WorktreeIdentity } from "@shigomori/contracts/schemas";
import {
  findProject,
  findProjectAndWorktree,
  findWorktreeIdentity,
  findWorktreePath,
  listWorktrees,
} from "@host/lib/projects";
import type * as Scripts from "@host/lib/Scripts";
import * as HostWorktrees from "@host/lib/Worktrees";
import * as PullRequestMaps from "@host/lib/githubCli/PullRequestMaps";
import { isEntityGoneError } from "@shigomori/contracts/errors";
import { readGitBlob, readWorktreeFile } from "@host/lib/worktrees/files";
import { inAppTerminal } from "@host/lib/terminals/inAppTerminal";
import type { Terminals } from "@host/lib/terminals/Terminals";
import { scriptEventNotifier, worktreeNotifiers } from "../scriptRun";
import * as Ops from "@host/lib/engineOps";
import type * as Engine from "@host/lib/Engine";

// The changes page's views of one worktree share this key prefix, so
// a refresh reads them all.
const treeViews = (input: { projectId: string; worktreeId: string }) =>
  `worktrees:tree:${input.projectId}:${input.worktreeId}:`;

// One of the changes page's views of a worktree (`part` its name and
// input), read again as the tree moves: its project's git, an edit in
// its files (or a window looking again), a mirror staging into it. A
// view of what the index holds (`index`: the changes, staged or not,
// and an operation's conflicts and squash) also follows its project's
// index writes, as a stage in a terminal makes one. A view of refs
// alone (`refsOnly`: the branch's history, the stashes) follows its
// project's git only: an edit, a window looking again and a mirror's
// index rewrite can't move it, and the first and last come as often as
// a mirror or an agent writes. A read git refuses for a moment (a lock
// held) is tried again three times, a second apart and doubling,
// before the view fails.
const treeView = <A, R>(
  input: { projectId: string; worktreeId: string },
  part: string,
  read: () => Effect.Effect<A, unknown, R>,
  options?: { readonly index?: boolean; readonly refsOnly?: boolean },
) =>
  Views.view(
    `${treeViews(input)}${part}`,
    () =>
      read().pipe(
        Effect.retry({
          times: 3,
          schedule: Schedule.exponential("1 second"),
          while: (error) => !isEntityGoneError(error),
        }),
      ),
    options?.refsOnly === true
      ? gitMoved(input.projectId)
      : Views.either(
          gitMoved(input.projectId),
          filesChanged(input.projectId),
          Views.pushed(mirrorContract, "gitChanged", (staged) => {
            return staged.worktreeId === input.worktreeId;
          }),
        ),
    options?.index === true
      ? { also: GitWatcher.indexWrittenIn(input.projectId) }
      : undefined,
  );

const gitMoved = (projectId: string) =>
  Views.either(
    Views.pushed(gitContract, "projectChanged", (moved) => {
      return moved.projectId === projectId;
    }),
    Views.pushed(gitContract, "refsRefreshed", (fetched) => {
      return fetched.projectId === projectId;
    }),
  );

// A file edited in one of the project's working trees, or a window
// looking again (a focus here, a peer's sweep that is no renewal).
const filesChanged = (projectId: string) =>
  Views.pushed(worktreesContract, "filesChanged", (changed) => {
    return changed.projectId === projectId;
  });

export const worktreesViews: ViewHandlers<
  typeof worktreesContract,
  Views.Services | Engine.Services | ChildProcessSpawner.ChildProcessSpawner
> = {
  watch: ({ projectId }) =>
    Views.view(
      `worktrees:watch:${projectId}`,
      () => listWorktrees(projectId),
      Views.either(
        Views.wrote(
          "projects",
          "project_config",
          "worktree_marks",
          "shelf_snapshots",
          "worktree_data",
          "agent_sessions",
          // Codex-style names and the idle shelf.
          "device_config",
        ),
        gitMoved(projectId),
        filesChanged(projectId),
      ),
    ),
  watchChangeStatus: (input) =>
    treeView(
      input,
      "changes",
      () => atPath(input, (path) => withGit((git) => git.changes(path))),
      { index: true },
    ),
  watchFileDiff: (input) =>
    treeView(
      input,
      `diff:${JSON.stringify([input.paths, input.untracked])}`,
      () =>
        atPath(input, (path) =>
          withGit((git) =>
            git.fileDiff({
              worktree: path,
              paths: input.paths,
              untracked: input.untracked,
            }),
          ),
        ),
    ),
  watchFileHunks: (input) =>
    treeView(input, `hunks:${input.path}`, () =>
      atPath(input, (path) =>
        withGit((git) => git.readHunks(path, input.path)),
      ),
    ),
  watchBranchHistory: (input) =>
    treeView(
      input,
      "history",
      () =>
        Effect.gen(function* () {
          const identity = yield* findWorktreeIdentity(
            input.projectId,
            input.worktreeId,
            { primaryRef: true },
          );
          return yield* (yield* Git.Git).readBranchHistory(identity.path, {
            base: branchBaseOf(identity),
            count: BRANCH_HISTORY_COUNT,
          });
        }),
      { refsOnly: true },
    ),
  watchStashes: (input) =>
    treeView(
      input,
      "stashes",
      () =>
        Effect.gen(function* () {
          const { worktree } = yield* findProjectAndWorktree(
            input.projectId,
            input.worktreeId,
          );
          if (worktree.detached) return [];
          return yield* (yield* Git.Git).listStashes(
            worktree.path,
            worktree.branch,
          );
        }),
      { refsOnly: true },
    ),
  watchOperation: (input) =>
    treeView(
      input,
      "operation",
      () => atPath(input, (path) => withGit((git) => git.readOperation(path))),
      { index: true },
    ),
};

export const worktreesHandlers = {
  // The rows are the engine's (`sm worktrees list`), which also answers
  // an unknown project id with the entity-gone error.
  list: ({ projectId }) => listWorktrees(projectId),

  // Lifecycle mutations run the engine a terminal runs.
  create: (
    { projectId, worktreeName, branchName, base, checkout, cloneFiles },
    ctx,
  ) =>
    Effect.flatMap(HostWorktrees.Worktrees, (worktrees) =>
      worktrees.create(
        { projectId, worktreeName, branchName, base, checkout, cloneFiles },
        worktreeNotifiers(ctx),
      ),
    ),

  convertExternal: ({ projectId, worktreeId, force }, ctx) =>
    Effect.flatMap(HostWorktrees.Worktrees, (worktrees) =>
      worktrees.adopt(
        { projectId, worktreeId, force: force !== false },
        worktreeNotifiers(ctx),
      ),
    ),

  relocationPlan: ({ projectId, layout, customPath }) =>
    Effect.gen(function* () {
      const { id, name, path } = yield* findProject(projectId);
      return yield* (yield* EngineWorktrees.Worktrees).relocationPlan(
        { id, name, path },
        {
          worktreeLayout: layout,
          customWorktreePath: customPath ?? undefined,
        },
      );
    }),

  relocate: (input) =>
    Effect.flatMap(HostWorktrees.Worktrees, (worktrees) =>
      worktrees.relocate(input),
    ),

  rename: (input) =>
    Effect.flatMap(HostWorktrees.Worktrees, (worktrees) =>
      worktrees.rename(input),
    ),

  delete: (input, ctx) =>
    Effect.flatMap(HostWorktrees.Worktrees, (worktrees) =>
      worktrees.remove(input, scriptEventNotifier(ctx)),
    ),

  deleteStack: (input, ctx) =>
    Effect.flatMap(HostWorktrees.Worktrees, (worktrees) =>
      worktrees.removeStack(input, scriptEventNotifier(ctx)),
    ),

  setShelved: ({ projectId, worktreeId, shelved }) =>
    mutateAndDescribe({ projectId, worktreeId }, (target, project) =>
      Ops.setShelved(project, target.id, shelved),
    ),

  // A flag flip only, like setShelved, answered with the refreshed row.
  // The pull itself has one entry point, the fetch scheduler's sweep
  // (host/lib/BackgroundFetch.ts): the renderer follows a mark with
  // git:refreshProject so the first pull happens right away, through
  // the same path as every later one.
  setAutoPull: ({ projectId, worktreeId, autoPull }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.setAutoPull(project, worktreeId, autoPull),
    ),

  idleAgents: ({ projectId, worktreeId }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.idleAgents(project, worktreeId),
    ),

  unbindAgent: ({ projectId, worktreeId, harness, session }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.unbindAgent(project, worktreeId, harness, session),
    ),

  resumeAgent: ({ projectId, worktreeId, harness, session }) =>
    inAppTerminal(
      Effect.flatMap(findProject(projectId), (project) =>
        Ops.resumeAgent(project, worktreeId, harness, session),
      ),
    ),

  // An edit made to the open PR's title moves the project's PR map.
  describe: ({ projectId, worktreeId, title, description }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const { worktree, editedPullRequest } = yield* Ops.describe(
        project,
        worktreeId,
        {
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
        },
      );
      if (editedPullRequest) {
        yield* (yield* PullRequestMaps.PullRequestMaps).retitled(
          project,
          worktree.branch,
          editedPullRequest.title,
        );
      }
      return worktree;
    }),

  renameBranch: (input) =>
    mutateAndDescribe(input, (wt) =>
      Effect.flatMap(Git.Git, (git) =>
        git.renameCurrentBranch(wt.path, input.newBranch),
      ),
    ),

  checkoutBranch: (input) =>
    mutateAndDescribe(input, (wt) =>
      Effect.flatMap(Git.Git, (git) =>
        git.checkoutBranch(wt.path, input.branch),
      ),
    ),

  readFile: ({ path, ...input }) =>
    atPath(input, (root) => readWorktreeFile(root, path)),

  readBlob: ({ oid, path, ...input }) =>
    atPath(input, (root) => readGitBlob(root, oid, path)),

  changeStatus: (input) =>
    atPath(input, (path) => withGit((git) => git.changes(path))),
  refreshChangeStatus: (input) => Views.refresh(treeViews(input)),

  discardHunks: (input) =>
    mutateAndDescribeWith(input, (wt) =>
      withGit((git) =>
        git.discardHunks({
          worktree: wt.path,
          path: input.path,
          changes: input.changes,
        }),
      ),
    ).pipe(
      Effect.map(({ result, worktree }) => ({ snapshot: result, worktree })),
    ),

  commit: (input) =>
    mutateAndDescribeWith(input, (wt) =>
      withGit((git) => git.commitPicks(wt.path, input)),
    ).pipe(Effect.map(({ result, worktree }) => ({ hash: result, worktree }))),

  discardChanges: (input) =>
    mutateAndDescribeWith(input, (wt) =>
      withGit((git) => git.discard({ worktree: wt.path, paths: input.paths })),
    ).pipe(
      Effect.map(({ result, worktree }) => ({ snapshot: result, worktree })),
    ),

  restoreDiscard: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) =>
        git.restoreDiscard({ worktree: wt.path, snapshot: input.snapshot }),
      ),
    ),

  commitMessage: (input) =>
    atPath(input, (path) =>
      withGit((git) => git.readCommitMessage(path, input.hash)),
    ),

  resetSoft: (input) =>
    mutateAndDescribeWith(input, (wt) =>
      withGit((git) =>
        git.resetSoft({
          worktree: wt.path,
          target: input.target,
          expectHead: input.expectHead,
        }),
      ),
    ).pipe(
      Effect.map(({ result, worktree }) => ({
        previousHead: result,
        worktree,
      })),
    ),

  resetHard: (input) =>
    mutateAndDescribeWith(input, (wt) =>
      withGit((git) =>
        git.resetHard({
          worktree: wt.path,
          ref: input.ref,
          expectHead: input.expectHead,
          restore: input.restore,
        }),
      ),
    ).pipe(Effect.map(({ result, worktree }) => ({ ...result, worktree }))),

  commitDiff: (input) =>
    atPath(input, (path) => withGit((git) => git.commitDiff(path, input.hash))),

  listCommits: ({ skip, count, query, from, ...input }) =>
    atPath(input, (path) =>
      withGit((git) => git.listCommits(path, { skip, count, query, from })),
    ),

  branchDiff: (input) =>
    Effect.gen(function* () {
      const identity = yield* findWorktreeIdentity(
        input.projectId,
        input.worktreeId,
        { primaryRef: true },
      );
      const base = branchBaseOf(identity);
      if (base === undefined) {
        return yield* new Git.GitRefusedError({
          reason: "This branch has no primary branch to compare with.",
        });
      }
      return yield* (yield* Git.Git).mergeBaseDiff({
        repo: identity.path,
        base,
        head: "HEAD",
      });
    }),

  revertCommit: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) => git.revertCommit(wt.path, input.hash)),
    ),
  cherryPick: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) => git.cherryPickCommit(wt.path, input.hash)),
    ),
  rewordCommit: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) =>
        git.rewordCommit({
          worktree: wt.path,
          hash: input.hash,
          summary: input.summary,
          description: input.description,
          expectHead: input.expectHead,
        }),
      ),
    ),
  squashCommit: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) =>
        git.squashIntoParent(wt.path, input.hash, input.expectHead),
      ),
    ),

  stashDiff: (input) =>
    atPath(input, (path) =>
      withGit((git) => git.readStashDiff(path, input.hash)),
    ),
  stashChanges: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) => git.stashChanges(wt.path, input.message)),
    ),
  applyStash: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) =>
        git.applyStash({
          worktree: wt.path,
          hash: input.hash,
          drop: input.drop,
        }),
      ),
    ),
  dropStash: (input) =>
    atPath(input, (path) => withGit((git) => git.dropStash(path, input.hash))),
  restoreStash: (input) =>
    Effect.gen(function* () {
      const { worktree } = yield* findProjectAndWorktree(
        input.projectId,
        input.worktreeId,
      );
      yield* (yield* Git.Git).restoreStash({
        worktree: worktree.path,
        branch: worktree.branch,
        hash: input.hash,
        message: input.message,
        named: input.named,
      });
    }),

  push: (input) =>
    mutateAndDescribe(input, (wt) => withGit((git) => git.push(wt.path))),
  pull: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) => git.pullFastForward(wt.path)),
    ),
  pushForce: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) => git.pushForceWithLease(wt.path)),
    ),
  overwrite: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) => git.overwriteFromUpstream(wt.path)),
    ),
  publish: (input) =>
    mutateAndDescribe(input, (wt, project) =>
      withGit((git) => git.publish({ worktree: wt.path, repo: project.path })),
    ),
  pullAndPush: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) => git.pullRebaseOrMergeAndPush(wt.path)),
    ),
  syncWithPrimary: (input) =>
    mutateAndDescribe(input, (target, project) =>
      Effect.flatMap(primaryRefToSync(target, project), (primaryRef) =>
        withGit((git) =>
          git.syncWithPrimary({
            worktree: target.path,
            repo: project.path,
            primaryRef,
          }),
        ),
      ),
    ),
  mergePrimary: (input) =>
    mutateAndDescribeWith(input, (target, project) =>
      Effect.flatMap(primaryRefToSync(target, project), (primaryRef) =>
        withGit((git) =>
          git.mergePrimaryKeepingConflicts({
            worktree: target.path,
            repo: project.path,
            primaryRef,
          }),
        ),
      ),
    ).pipe(
      Effect.map(({ result, worktree }) => ({ worktree, stopped: result })),
    ),

  mergeUpstream: (input) =>
    mutateAndDescribeWith(input, (wt) =>
      withGit((git) => git.mergeUpstreamKeepingConflicts(wt.path)),
    ).pipe(
      Effect.map(({ result, worktree }) => ({ worktree, stopped: result })),
    ),

  resolveConflict: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) =>
        git.resolveConflict({
          worktree: wt.path,
          path: input.path,
          side: input.side,
        }),
      ),
    ),
  mergePreview: (input) =>
    atPath(input, (path) =>
      withGit((git) => git.readMergePreview(path, input.ref, input.countsOnly)),
    ),
  mergeBranch: (input) =>
    mutateAndDescribeWith(input, (wt) =>
      withGit((git) =>
        git.mergeBranch({
          worktree: wt.path,
          ref: input.ref,
          method: input.method,
          message: input.message,
        }),
      ),
    ).pipe(
      Effect.map(({ result, worktree }) => ({ worktree, stopped: result })),
    ),
  continueOperation: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) => git.continueOperation(wt.path)),
    ),
  abortOperation: (input) =>
    mutateAndDescribe(input, (wt) =>
      withGit((git) => git.abortOperation(wt.path)),
    ),
  switchToPrimaryAndDeleteBranch: (input) =>
    Effect.flatMap(findProject(input.projectId), (project) =>
      Ops.finishWorktree(project, input.worktreeId),
    ),
} satisfies EffectHandlers<
  typeof worktreesContract,
  HandlerContext,
  | Scripts.Scripts
  | HostWorktrees.Worktrees
  | Terminals
  | PullRequestMaps.PullRequestMaps
  | PeerReach
  | HostPushes.HostPushes
  | ScriptChanges
  | ChildProcessSpawner.ChildProcessSpawner
  | Engine.Services
  | Views.ViewShares
>;

// How many of a branch's own commits the Git timeline is handed. A
// branch rarely has more, and past this it says there are more.
const BRANCH_HISTORY_COUNT = 50;

// What a worktree's branch is measured against: the primary ref, for
// a branch of its own. The primary checkout, the primary branch checked
// out elsewhere and a detached HEAD have none.
function branchBaseOf(identity: WorktreeIdentity): string | undefined {
  if (identity.isPrimary || identity.detached) return undefined;
  if (identity.branch === identity.primaryBranch) return undefined;
  return identity.primaryRef;
}

// The ref a sync from primary takes in, refusing the worktrees it has
// no meaning for.
const primaryRefToSync = Effect.fnUntraced(function* (
  target: WorktreeIdentity,
  project: Project,
) {
  if (target.isPrimary) {
    return yield* new Git.GitRefusedError({
      reason: "The primary checkout can't be synced from itself",
    });
  }
  if (target.detached) {
    return yield* new Git.GitRefusedError({
      reason: "Detached worktrees can't be synced with the primary branch",
    });
  }
  const { primaryRef } = yield* findWorktreeIdentity(project.id, target.id, {
    primaryRef: true,
  });
  if (primaryRef === undefined) {
    return yield* new Git.GitRefusedError({
      reason: `No primary branch resolves in ${project.path}`,
    });
  }
  return primaryRef;
});

// A call on the engine's Git.
const withGit = <A, E, R>(
  call: (git: Git.Git["Service"]) => Effect.Effect<A, E, R>,
) => Effect.flatMap(Git.Git, call);

const atPath = <A, E, R>(
  scope: { projectId: string; worktreeId: string },
  action: (path: string) => Effect.Effect<A, E, R>,
) => Effect.flatMap(findWorktreePath(scope), action);

// Worktree mutations (remote syncs, local branch ops, commits) all share
// the same shape: resolve the worktree, run a git action, return the
// freshly-described worktree (the engine's row) so the renderer can
// replace its cached row in one round trip. The `With` form also hands
// back what the action produced (a commit hash, a snapshot ref) for the
// calls that have one. The id resolved names the worktree throughout,
// so a call by one it had before a move describes it too.
const mutateAndDescribeWith = <T, E, R>(
  { projectId, worktreeId }: { projectId: string; worktreeId: string },
  action: (
    target: WorktreeIdentity,
    project: Project,
  ) => Effect.Effect<T, E, R>,
) =>
  Effect.gen(function* () {
    const { project, worktree } = yield* findProjectAndWorktree(
      projectId,
      worktreeId,
    );
    const result = yield* action(worktree, project);
    return {
      result,
      worktree: yield* Ops.describeWorktree(project.id, worktree.id),
    };
  });

const mutateAndDescribe = <T, E, R>(
  scope: { projectId: string; worktreeId: string },
  action: (
    target: WorktreeIdentity,
    project: Project,
  ) => Effect.Effect<T, E, R>,
) => Effect.map(mutateAndDescribeWith(scope, action), (done) => done.worktree);
