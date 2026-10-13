import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HostPushes from "@host/lib/HostPushes";
import type { ScriptChanges } from "@host/lib/scripts/ScriptChanges";
import type { PeerReach } from "@host/ipc/PeerReach";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { GithubCli } from "@host/lib/githubCli/GithubCli";
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
  currentWorktreeId,
  findProject,
  findProjectAndWorktree,
  findWorktreeIdentity,
  findWorktreePath,
  listWorktrees,
} from "@host/lib/projects";
import {
  assertWorktreeMutable,
  getRunningScriptWorktrees,
  killScriptsForWorktree,
  withDeleteInflight,
  withDeletesInflight,
} from "@host/lib/scripts";
import { refreshProjectPullRequests } from "@host/lib/githubCli/pullRequests";
import {
  pullRequestStackFor,
  stackCleanupFor,
  trunkOf,
} from "@shigomori/contracts/pullRequestStack";
import {
  isEntityGoneError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import { readWorktreeFile } from "@host/lib/worktrees/files";
import { Terminals } from "@host/lib/terminals/Terminals";
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import {
  moveMirrorsOfWorktree,
  stopMirrorsForWorktree,
} from "@host/mirror/registry";
import { scriptEventNotifier } from "../scriptRun";
import * as Ops from "@host/lib/engineOps";
import type * as Engine from "@host/lib/Engine";

// Exported for the sync module's pull orchestration, whose createWorktree
// call streams the same lifecycle events.
export function notifierFor(ctx: HandlerContext) {
  return {
    notifyPhase: ctx.notifier(worktreesContract, "lifecyclePhase"),
    notifyCarryOverComplete: ctx.notifier(
      worktreesContract,
      "carryOverComplete",
    ),
    notifyScript: scriptEventNotifier(ctx),
  };
}

// The changes page's views of one worktree share this key prefix, so
// a refresh reads them all.
const treeViews = (input: { projectId: string; worktreeId: string }) =>
  `worktrees:tree:${input.projectId}:${input.worktreeId}:`;

// One of the changes page's views of a worktree (`part` its name and
// input), read again as the tree moves: its project's git, an edit in
// its files (or a window looking again), a mirror staging into it. A
// read git refuses for a moment (a lock held) is tried again three
// times, a second apart and doubling, as a request was, before the
// view fails.
const treeView = <A, R>(
  input: { projectId: string; worktreeId: string },
  part: string,
  read: () => Effect.Effect<A, unknown, R>,
  options?: { readonly every?: Duration.Input },
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
    Views.either(
      gitMoved(input.projectId),
      filesChanged(input.projectId),
      Views.pushed(mirrorContract, "gitChanged", (staged) => {
        return staged.worktreeId === input.worktreeId;
      }),
    ),
    options,
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

// The transplant's teardown refused: scripts run in the worktree.
class ScriptsRunningError extends Schema.TaggedError<ScriptsRunningError>()(
  "ScriptsRunningError",
  { scripts: Schema.Natural },
) {
  override get message(): string {
    return `scripts-running: ${this.scripts} script(s) are running in this worktree`;
  }
}

class NoMergedLayerError extends Schema.TaggedError<NoMergedLayerError>()(
  "NoMergedLayerError",
  {},
) {
  override get message(): string {
    return "No merged layer of this stack has a worktree to remove.";
  }
}

class PrimaryRelocateError extends Schema.TaggedError<PrimaryRelocateError>()(
  "PrimaryRelocateError",
  {},
) {
  override get message(): string {
    return "The primary checkout can't be relocated";
  }
}

const counted = (n: number, noun: string) =>
  n === 0 ? [] : [`${n} ${noun}${n === 1 ? "" : "s"}`];

class RunningWorkError extends Schema.TaggedError<RunningWorkError>()(
  "RunningWorkError",
  {
    verb: Schema.Literals(["move", "rename"]),
    name: Schema.String,
    scripts: Schema.Natural,
    terminals: Schema.Natural,
  },
) {
  override get message(): string {
    const running = [
      ...counted(this.scripts, "script"),
      ...counted(this.terminals, "terminal"),
    ];
    const one = this.scripts + this.terminals === 1;
    return `Can't ${this.verb} ${this.name} while ${running.join(" and ")} ${one ? "is" : "are"} running there. Stop ${one ? "it" : "them"} first.`;
  }
}

// The scripts and terminals running in a worktree hold its folder, so a
// move or a rename waits until they are stopped.
const refuseRunningWork = Effect.fn("worktrees.refuseRunningWork")(function* (
  worktree: { id: string; name: string; path: string },
  verb: "move" | "rename",
) {
  const scripts =
    getRunningScriptWorktrees().find(
      (entry) => entry.worktreeId === worktree.id,
    )?.scriptCount ?? 0;
  const open = yield* Stream.runHead((yield* Terminals).list);
  const terminals = Option.getOrElse(open, () => []).filter(({ owner, cwd }) =>
    owner.kind === "worktree"
      ? owner.worktreeId === worktree.id
      : isSameOrInside(cwd, worktree.path),
  ).length;
  if (scripts + terminals > 0) {
    return yield* new RunningWorkError({
      verb,
      name: worktree.name,
      scripts,
      terminals,
    });
  }
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
  // The open page's changes: also read again every few seconds, for an
  // edit no watch saw.
  watchChangeStatus: (input) =>
    treeView(
      input,
      "changes",
      () => atPath(input, (path) => withGit((git) => git.changes(path))),
      { every: "2 seconds" },
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
    treeView(input, "history", () => worktreesHandlers.branchHistory(input)),
  watchStashes: (input) =>
    treeView(input, "stashes", () => worktreesHandlers.stashes(input)),
  watchOperation: (input) =>
    treeView(input, "operation", () =>
      atPath(input, (path) => withGit((git) => git.readOperation(path))),
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
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.createWorktree(
        project,
        { worktreeName, branchName, base, checkout, cloneFiles },
        notifierFor(ctx),
      ),
    ),

  // A renderer from before the field sends none and expects the force
  // it always got, so only an explicit false runs unforced.
  convertExternal: ({ projectId, worktreeId, force }, ctx) =>
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.adoptWorktree(project, worktreeId, force !== false, notifierFor(ctx)),
    ),

  // `sm worktrees move` moves the checkout and carries what is keyed by
  // its path-derived id to the new id. What lives in this process stays
  // here: the running work it refuses, the tombstone that refuses a
  // concurrent delete or move, and the mirrors rooted in it, re-opened
  // on the new path.
  relocate: ({ projectId, worktreeId, destinationPath }) =>
    Effect.gen(function* () {
      const { project, worktree } = yield* findProjectAndWorktree(
        projectId,
        worktreeId,
      );
      if (worktree.isPrimary) return yield* new PrimaryRelocateError();
      // Already where it should be: refresh the row.
      if (worktree.path === destinationPath) {
        return yield* Ops.describeWorktree(project.id, worktreeId);
      }
      yield* refuseRunningWork(worktree, "move");
      return yield* withDeleteInflight(
        worktreeId,
        "This worktree is already being removed or moved.",
        Ops.moveWorktree(project, worktreeId, destinationPath),
        (moved) => moveMirrorsOfWorktree(worktreeId, moved),
      );
    }),

  // A move to the same parent under a new name, with a move's guards.
  rename: ({ projectId, worktreeId, name }) =>
    Effect.gen(function* () {
      const { project, worktree } = yield* findProjectAndWorktree(
        projectId,
        worktreeId,
      );
      if (worktree.name === name) {
        return yield* Ops.describeWorktree(project.id, worktreeId);
      }
      yield* refuseRunningWork(worktree, "rename");
      return yield* withDeleteInflight(
        worktreeId,
        "This worktree is already being removed or moved.",
        Ops.renameWorktree(project, worktreeId, name),
        (renamed) => moveMirrorsOfWorktree(worktreeId, renamed),
      );
    }),

  delete: (
    { projectId, worktreeId: named, force, skipCleanup, refuseRunningScripts },
    ctx,
  ) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      // A mirror's stop names its copy by the id it may have had before a
      // move.
      const worktreeId = yield* currentWorktreeId(projectId, named);
      // Local delete kills scripts by design (withDeleteInflight reaps
      // them). The transplant orchestrator refuses instead, since its
      // teardown must never take down work still running on the source
      // device. The lookup is app-registry-only, so the engine stays
      // ignorant of the flag. "scripts-running" is a stable marker the
      // orchestrator and the UI match on, not prose.
      if (refuseRunningScripts) {
        const running = getRunningScriptWorktrees().find(
          (entry) => entry.worktreeId === worktreeId,
        );
        if (running !== undefined) {
          return yield* new ScriptsRunningError({
            scripts: running.scriptCount,
          });
        }
      }
      // The engine can't see the app's script registry, so the delete runs
      // under the shared tombstone protocol (see withDeleteInflight).
      // The engine drops the shelf and auto-pull marks with the worktree.
      // The announcement brackets this call's run only. A second caller
      // is refused up front (withDeleteInflight would refuse it the
      // same way), so its "kept" cannot close the first one's removal
      // under every viewer. The close carries the outcome, so a viewer
      // drops the row exactly when the delete did.
      const busy = "This worktree is already being removed.";
      yield* assertWorktreeMutable(worktreeId, busy);
      yield* HostPushes.push(worktreesContract, "removal", {
        projectId,
        worktreeId,
        state: "removing",
      });
      let removed = false;
      return yield* withDeleteInflight(
        worktreeId,
        busy,
        Ops.deleteWorktree(
          project,
          { worktreeId, force, skipCleanup },
          notifierFor(ctx),
        ),
        (outcome) =>
          outcome.ok ? stopMirrorsForWorktree(worktreeId) : Effect.void,
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            removed = result.ok;
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() =>
            HostPushes.push(worktreesContract, "removal", {
              projectId,
              worktreeId,
              state: removed ? "removed" : "kept",
            }),
          ),
        ),
      );
    }),

  // The merged layers' worktrees of the stack `worktreeId` is in, as
  // one removal. The set is read the way the page reads it (the PR map
  // and the listing), off a fresh sweep of the PRs so it is what the
  // engine, which resolves the stack against GitHub itself, finds landed
  // too. Every worktree of the set is announced and guarded like a
  // single delete, since the one engine call takes them all. One the engine
  // took past the set (a layer that landed in the moment between) gets
  // its scripts reaped and its removal announced once it is gone.
  deleteStack: ({ projectId, worktreeId, force, skipCleanup }, ctx) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const [identities, prs] = yield* Effect.all(
        [
          Ops.listWorktreeIdentities({ projectId }, { primaryRef: true }),
          refreshProjectPullRequests(project.path),
        ],
        { concurrency: 2 },
      );
      const own = identities.find((identity) => identity.id === worktreeId);
      if (!own) return yield* new UnknownWorktreeError({ worktreeId });
      const stack = pullRequestStackFor(
        Object.fromEntries(prs),
        own.branch,
        trunkOf(identities),
      );
      const cleanup = stack && stackCleanupFor(stack, identities);
      if (!cleanup) return yield* new NoMergedLayerError();
      const ids = cleanup.worktrees.map((identity) => identity.id);
      const busy = "A worktree of this stack is already being removed.";
      for (const id of ids) yield* assertWorktreeMutable(id, busy);
      for (const id of ids) {
        yield* HostPushes.push(worktreesContract, "removal", {
          projectId,
          worktreeId: id,
          state: "removing",
        });
      }
      let removed: readonly string[] = [];
      return yield* withDeletesInflight(
        ids,
        busy,
        Ops.deleteStack(
          project,
          { worktreeId: cleanup.target.id, force, skipCleanup },
          notifierFor(ctx),
        ),
        (outcome) =>
          Effect.forEach(outcome.removed, stopMirrorsForWorktree, {
            concurrency: "unbounded",
            discard: true,
          }),
      ).pipe(
        Effect.tap((result) =>
          Effect.gen(function* () {
            removed = result.removed;
            yield* Effect.forEach(
              removed.filter((id) => !ids.includes(id)),
              killScriptsForWorktree,
              { concurrency: "unbounded", discard: true },
            );
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() =>
            Effect.forEach(
              ids,
              (id) =>
                HostPushes.push(worktreesContract, "removal", {
                  projectId,
                  worktreeId: id,
                  state: removed.includes(id) ? "removed" : "kept",
                }),
              { discard: true },
            ),
          ),
        ),
      );
    }),

  setShelved: ({ projectId, worktreeId, shelved }) =>
    mutateAndDescribe({ projectId, worktreeId }, (_target, project) =>
      Ops.setShelved(project, worktreeId, shelved),
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
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.resumeAgent(project, worktreeId, harness, session),
    ),

  describe: ({ projectId, worktreeId, title, description }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.describe(project, worktreeId, {
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
      }),
    ),

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

  fileDiff: (input) =>
    atPath(input, (path) =>
      withGit((git) =>
        git.fileDiff({
          worktree: path,
          paths: input.paths,
          untracked: input.untracked,
        }),
      ),
    ),

  readFile: ({ path, ...input }) =>
    atPath(input, (root) => readWorktreeFile(root, path)),

  changeStatus: (input) =>
    atPath(input, (path) => withGit((git) => git.changes(path))),
  refreshChangeStatus: (input) => Views.refresh(treeViews(input)),

  fileHunks: (input) =>
    atPath(input, (path) => withGit((git) => git.readHunks(path, input.path))),
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

  branchHistory: (input) =>
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

  stashes: (input) =>
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

  operation: (input) =>
    atPath(input, (path) => withGit((git) => git.readOperation(path))),
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
  | Terminals
  | GithubCli
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

// A git read or write on the worktree's checkout.
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
// calls that have one.
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
      worktree: yield* Ops.describeWorktree(project.id, worktreeId),
    };
  });

const mutateAndDescribe = <T, E, R>(
  scope: { projectId: string; worktreeId: string },
  action: (
    target: WorktreeIdentity,
    project: Project,
  ) => Effect.Effect<T, E, R>,
) => Effect.map(mutateAndDescribeWith(scope, action), (done) => done.worktree);
