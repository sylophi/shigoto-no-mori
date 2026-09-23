import { Effect } from "effect";
import { ScriptsRunning } from "@shared/errors";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import {
  type DeleteWorktreePayloadSchema,
  type Project,
  type ProjectScopedPayloadSchema,
  type SetShelvedPayloadSchema,
} from "@shared/schemas";
import { projectConfigOrNull } from "@host/lib/config/project";
import {
  checkoutBranchEffect,
  renameBranchEffect,
} from "@host/lib/git/branches";
import {
  commitStagedEffect,
  discardChangesEffect,
  listChangesForPageEffect,
  readCommitMessageEffect,
  resetSoftEffect,
  restoreDiscardEffect,
  setStagedEffect,
} from "@host/lib/git/changes";
import { getCommitDiffEffect, getFileDiffEffect } from "@host/lib/git/diff";
import { resolveDefaultBranchEffect } from "@host/lib/git/remotes";
import {
  overwriteFromUpstreamEffect,
  publishCurrentBranchEffect,
  pullFastForwardEffect,
  pullRebaseOrMergeAndPushEffect,
  pushFastForwardEffect,
  pushForceWithLeaseEffect,
  syncWithPrimaryEffect,
} from "@host/lib/git/sync";
import {
  describeWorktreeEffect,
  findWorktreeIdentityEffect,
  listCommitsEffect,
  listWorktreesEffect,
  type WorktreeIdentity,
} from "@host/lib/git/worktrees";
import { findProject, findProjectAndWorktree } from "@host/lib/projects";
import {
  getRunningScriptWorktrees,
  withDeleteInflight,
} from "@host/lib/scripts";
import { setAutoPull } from "@host/lib/worktrees/autoPull";
import { relocateWorktreeToManagedPath } from "@host/lib/worktrees/relocate";
import { type HostServices, hostAttempt, hostHandler } from "@host/runtime";
import { scriptEventNotifier } from "../scriptRun";
import {
  adoptViaCli,
  createViaCli,
  deleteViaCli,
  doneViaCli,
  setShelvedViaCli,
} from "../cliDelegate";

// Exported for the sync module's pull orchestration, whose createViaCli
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

// The worktree a read-only handler asks about.
const worktreeOf = (projectId: string, worktreeId: string) =>
  Effect.map(findProjectAndWorktree(projectId, worktreeId), (r) => r.worktree);

// The programs other modules run inside their own (the mirror's stop,
// a send's teardown, the control ops), exported as Effects so the
// caller's interruption, and any step it marked uninterruptible,
// reaches them directly rather than through a signal.
export const listWorktrees = ({
  projectId,
}: typeof ProjectScopedPayloadSchema.Type) =>
  Effect.flatMap(findProject(projectId), (project) =>
    listWorktreesEffect(project.id, project.path),
  );

export const deleteWorktree = (
  {
    projectId,
    worktreeId,
    force,
    skipCleanup,
    refuseRunningScripts,
  }: typeof DeleteWorktreePayloadSchema.Type,
  ctx: HandlerContext,
) =>
  Effect.flatMap(findProject(projectId), (project) =>
    hostAttempt(() => {
      // Local delete kills scripts by design (withDeleteInflight
      // reaps them). The transplant orchestrator refuses instead,
      // since its teardown must never take down work still running
      // on the source device. The lookup is app-registry-only, so
      // the CLI stays ignorant of the flag. The refusal is typed
      // (ScriptsRunning), and the UI matches its tag.
      if (refuseRunningScripts) {
        const running = getRunningScriptWorktrees().find(
          (entry) => entry.worktreeId === worktreeId,
        );
        if (running !== undefined) {
          throw new ScriptsRunning({ scriptCount: running.scriptCount });
        }
      }
      // The CLI can't see the app's script registry, so the delete
      // runs under the shared tombstone protocol (see
      // withDeleteInflight). The CLI drops the shelf and auto-pull
      // marks with the worktree.
      return withDeleteInflight(
        worktreeId,
        "This worktree is already being removed.",
        () =>
          deleteViaCli(
            project,
            { worktreeId, force, skipCleanup },
            notifierFor(ctx),
          ),
      );
    }),
  );

export const setShelvedWorktree = ({
  projectId,
  worktreeId,
  shelved,
}: typeof SetShelvedPayloadSchema.Type) =>
  mutateAndDescribe({ projectId, worktreeId }, (_target, project) =>
    hostAttempt(() => setShelvedViaCli(project, worktreeId, shelved)),
  );

export const worktreesHandlers: Handlers<
  typeof worktreesContract,
  HandlerContext
> = {
  list: hostHandler(listWorktrees),

  // Lifecycle mutations route through the bundled CLI so the app and a
  // terminal run the same engine. Each is one step: a caller that
  // leaves stops waiting, never the lifecycle halfway.
  create: hostHandler(
    ({ projectId, worktreeName, branchName, base, checkout }, ctx) =>
      Effect.flatMap(findProject(projectId), (project) =>
        hostAttempt(() =>
          createViaCli(
            project,
            { worktreeName, branchName, base, checkout },
            notifierFor(ctx),
          ),
        ),
      ),
  ),

  convertExternal: hostHandler(({ projectId, worktreeId }, ctx) =>
    Effect.flatMap(findProject(projectId), (project) =>
      hostAttempt(() => adoptViaCli(project, worktreeId, notifierFor(ctx))),
    ),
  ),

  relocate: hostHandler(({ projectId, worktreeId, destinationPath }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      hostAttempt(() =>
        relocateWorktreeToManagedPath(project, worktreeId, destinationPath),
      ),
    ),
  ),

  delete: hostHandler(deleteWorktree),

  setShelved: hostHandler(setShelvedWorktree),

  // A flag flip only, like setShelved. The pull itself has one entry
  // point, the fetch scheduler's sweep (main/electron/fetch.ts): the
  // renderer follows a mark with git:refreshProject so the first pull
  // happens right away, through the same path as every later one.
  setAutoPull: hostHandler(({ projectId, worktreeId, autoPull }) =>
    mutateAndDescribe({ projectId, worktreeId }, () =>
      hostAttempt(() => setAutoPull(worktreeId, autoPull)),
    ),
  ),

  renameBranch: hostHandler((input) =>
    mutateAndDescribe(input, (wt) =>
      renameBranchEffect(wt.path, input.newBranch),
    ),
  ),

  checkoutBranch: hostHandler((input) =>
    mutateAndDescribe(input, (wt) =>
      checkoutBranchEffect(wt.path, input.branch),
    ),
  ),

  fileDiff: hostHandler(({ projectId, worktreeId, paths, untracked }) =>
    Effect.flatMap(worktreeOf(projectId, worktreeId), (worktree) =>
      getFileDiffEffect(worktree.path, paths, untracked),
    ),
  ),

  changeStatus: hostHandler(({ projectId, worktreeId }) =>
    Effect.flatMap(worktreeOf(projectId, worktreeId), (worktree) =>
      listChangesForPageEffect(worktree.path),
    ),
  ),

  setStaged: hostHandler(({ projectId, worktreeId, paths, staged }) =>
    Effect.flatMap(worktreeOf(projectId, worktreeId), (worktree) =>
      setStagedEffect(worktree.path, paths, staged),
    ),
  ),

  commit: hostHandler((input) =>
    Effect.map(
      mutateAndDescribeWith(input, (wt) => commitStagedEffect(wt.path, input)),
      ({ result: hash, worktree }) => ({ hash, worktree }),
    ),
  ),

  discardChanges: hostHandler((input) =>
    Effect.map(
      mutateAndDescribeWith(input, (wt) =>
        discardChangesEffect(wt.path, input.paths),
      ),
      ({ result: snapshot, worktree }) => ({ snapshot, worktree }),
    ),
  ),

  restoreDiscard: hostHandler((input) =>
    mutateAndDescribe(input, (wt) =>
      restoreDiscardEffect(wt.path, input.snapshot),
    ),
  ),

  commitMessage: hostHandler(({ projectId, worktreeId, hash }) =>
    Effect.flatMap(worktreeOf(projectId, worktreeId), (worktree) =>
      readCommitMessageEffect(worktree.path, hash),
    ),
  ),

  resetSoft: hostHandler((input) =>
    Effect.map(
      mutateAndDescribeWith(input, (wt) =>
        resetSoftEffect(wt.path, input.target, input.expectHead),
      ),
      ({ result: previousHead, worktree }) => ({ previousHead, worktree }),
    ),
  ),

  commitDiff: hostHandler(({ projectId, worktreeId, hash }) =>
    Effect.flatMap(worktreeOf(projectId, worktreeId), (worktree) =>
      getCommitDiffEffect(worktree.path, hash),
    ),
  ),

  listCommits: hostHandler(({ projectId, worktreeId, skip, count }) =>
    Effect.flatMap(worktreeOf(projectId, worktreeId), (worktree) =>
      listCommitsEffect(worktree.path, { skip, count }),
    ),
  ),

  push: hostHandler((input) =>
    mutateAndDescribe(input, (wt) => pushFastForwardEffect(wt.path)),
  ),
  pull: hostHandler((input) =>
    mutateAndDescribe(input, (wt) => pullFastForwardEffect(wt.path)),
  ),
  pushForce: hostHandler((input) =>
    mutateAndDescribe(input, (wt) => pushForceWithLeaseEffect(wt.path)),
  ),
  overwrite: hostHandler((input) =>
    mutateAndDescribe(input, (wt) => overwriteFromUpstreamEffect(wt.path)),
  ),
  publish: hostHandler((input) =>
    mutateAndDescribe(input, (wt, project) =>
      publishCurrentBranchEffect(wt.path, project.path),
    ),
  ),
  pullAndPush: hostHandler((input) =>
    mutateAndDescribe(input, (wt) => pullRebaseOrMergeAndPushEffect(wt.path)),
  ),
  syncWithPrimary: hostHandler((input) =>
    mutateAndDescribe(input, (target, project) =>
      Effect.gen(function* () {
        if (target.isPrimary) {
          return yield* Effect.fail(
            new Error("The primary checkout can't be synced from itself"),
          );
        }
        if (target.detached) {
          return yield* Effect.fail(
            new Error(
              "Detached worktrees can't be synced with the primary branch",
            ),
          );
        }
        const primaryRef = yield* resolvePrimaryRef(
          target.projectId,
          project.path,
        );
        yield* syncWithPrimaryEffect(target.path, project.path, primaryRef);
      }),
    ),
  ),
  switchToPrimaryAndDeleteBranch: hostHandler((input) =>
    Effect.flatMap(findProject(input.projectId), (project) =>
      hostAttempt(() => doneViaCli(project, input.worktreeId)),
    ),
  ),
};

// Resolve the project's primary ref, honoring the configured override.
const resolvePrimaryRef = Effect.fnUntraced(function* (
  projectId: string,
  projectPath: string,
) {
  const config = yield* projectConfigOrNull(projectId);
  return yield* resolveDefaultBranchEffect(projectPath, config?.defaultBranch);
});

// Worktree mutations (remote syncs, local branch ops, commits) all share
// the same shape: resolve the worktree, run a git action, return the
// freshly-described worktree so the renderer can replace its cached row
// in one round trip. The `With` form also hands back what the action
// produced (a commit hash, a snapshot ref) for the calls that have one.
// Mutation, then refetch: sequential by design.
function mutateAndDescribeWith<A, E>(
  { projectId, worktreeId }: { projectId: string; worktreeId: string },
  action: (
    target: WorktreeIdentity,
    project: Project,
  ) => Effect.Effect<A, E, HostServices>,
) {
  return Effect.gen(function* () {
    const { project, worktree } = yield* findProjectAndWorktree(
      projectId,
      worktreeId,
    );
    const result = yield* action(worktree, project);
    const refreshed = yield* findWorktreeIdentityEffect(
      project.id,
      project.path,
      worktreeId,
    );
    return {
      result,
      worktree: yield* describeWorktreeEffect(refreshed, project.path),
    };
  });
}

function mutateAndDescribe<A, E>(
  scope: { projectId: string; worktreeId: string },
  action: (
    target: WorktreeIdentity,
    project: Project,
  ) => Effect.Effect<A, E, HostServices>,
) {
  return Effect.map(mutateAndDescribeWith(scope, action), (r) => r.worktree);
}
