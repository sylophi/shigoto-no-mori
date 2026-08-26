import { worktreesContract } from "@shared/ipc/modules/worktrees";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import type { Project, Worktree } from "@shared/schemas";
import { readShigomoriConfig } from "@host/lib/config/project";
import { checkoutBranch, renameBranch } from "@host/lib/git/branches";
import { getCommitDiff, getWorktreeDiff } from "@host/lib/git/diff";
import { resolveDefaultBranch } from "@host/lib/git/remotes";
import {
  overwriteFromUpstream,
  publishCurrentBranch,
  pullFastForward,
  pullRebaseOrMergeAndPush,
  pushFastForward,
  pushForceWithLease,
  syncWithPrimary,
} from "@host/lib/git/sync";
import {
  describeWorktree,
  findWorktreeIdentityOrThrow,
  listCommits,
  listWorktrees,
  type WorktreeIdentity,
} from "@host/lib/git/worktrees";
import {
  findProjectAndWorktreeOrThrow,
  findProjectOrThrow,
} from "@host/lib/projects";
import {
  getRunningScriptWorktrees,
  withDeleteInflight,
} from "@host/lib/scripts";
import { relocateWorktreeToManagedPath } from "@host/lib/worktrees/relocate";
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

export const worktreesHandlers: Handlers<
  typeof worktreesContract,
  HandlerContext
> = {
  list: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return listWorktrees(project.id, project.path);
  },

  // Lifecycle mutations route through the bundled CLI so the app and a
  // terminal run the same engine.
  create: async (
    { projectId, worktreeName, branchName, base, checkout },
    ctx,
  ) => {
    const project = findProjectOrThrow(projectId);
    const input = { worktreeName, branchName, base, checkout };
    return createViaCli(project, input, notifierFor(ctx));
  },

  convertExternal: async ({ projectId, worktreeId }, ctx) => {
    const project = findProjectOrThrow(projectId);
    return adoptViaCli(project, worktreeId, notifierFor(ctx));
  },

  relocate: async ({ projectId, worktreeId, destinationPath }) => {
    const project = findProjectOrThrow(projectId);
    return relocateWorktreeToManagedPath(project, worktreeId, destinationPath);
  },

  delete: async (
    { projectId, worktreeId, force, skipCleanup, refuseRunningScripts },
    ctx,
  ) => {
    const project = findProjectOrThrow(projectId);
    // Local delete kills scripts by design (withDeleteInflight reaps
    // them). The transplant orchestrator refuses instead, since its
    // teardown must never take down work still running on the source
    // device. The lookup is app-registry-only, so the CLI stays
    // ignorant of the flag. "scripts-running" is a stable marker the
    // orchestrator and the UI match on, not prose.
    if (refuseRunningScripts) {
      const running = getRunningScriptWorktrees().find(
        (entry) => entry.worktreeId === worktreeId,
      );
      if (running !== undefined) {
        throw new Error(
          `scripts-running: ${running.scriptCount} script(s) are running in this worktree`,
        );
      }
    }
    // The CLI can't see the app's script registry, so the delete runs
    // under the shared tombstone protocol (see withDeleteInflight).
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
  },

  setShelved: ({ projectId, worktreeId, shelved }) =>
    mutateAndDescribe({ projectId, worktreeId }, (_target, project) =>
      setShelvedViaCli(project, worktreeId, shelved),
    ),

  renameBranch: (input) =>
    mutateAndDescribe(input, (wt) => renameBranch(wt.path, input.newBranch)),

  checkoutBranch: (input) =>
    mutateAndDescribe(input, (wt) => checkoutBranch(wt.path, input.branch)),

  diff: async ({ projectId, worktreeId }) => {
    const { worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    return getWorktreeDiff(worktree.path);
  },

  commitDiff: async ({ projectId, worktreeId, hash }) => {
    const { worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    return getCommitDiff(worktree.path, hash);
  },

  listCommits: async ({ projectId, worktreeId, skip, count }) => {
    const { worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    return listCommits(worktree.path, { skip, count });
  },

  push: (input) => mutateAndDescribe(input, (wt) => pushFastForward(wt.path)),
  pull: (input) => mutateAndDescribe(input, (wt) => pullFastForward(wt.path)),
  pushForce: (input) =>
    mutateAndDescribe(input, (wt) => pushForceWithLease(wt.path)),
  overwrite: (input) =>
    mutateAndDescribe(input, (wt) => overwriteFromUpstream(wt.path)),
  publish: (input) =>
    mutateAndDescribe(input, (wt, project) =>
      publishCurrentBranch(wt.path, project.path),
    ),
  pullAndPush: (input) =>
    mutateAndDescribe(input, (wt) => pullRebaseOrMergeAndPush(wt.path)),
  syncWithPrimary: (input) =>
    mutateAndDescribe(input, async (target, project) => {
      if (target.isPrimary) {
        throw new Error("The primary checkout can't be synced from itself");
      }
      if (target.detached) {
        throw new Error(
          "Detached worktrees can't be synced with the primary branch",
        );
      }
      const primaryRef = await resolvePrimaryRef(
        target.projectId,
        project.path,
      );
      await syncWithPrimary(target.path, project.path, primaryRef);
    }),
  switchToPrimaryAndDeleteBranch: async (input) => {
    const project = findProjectOrThrow(input.projectId);
    return doneViaCli(project, input.worktreeId);
  },
};

// Resolve the project's primary ref, honoring the configured override.
async function resolvePrimaryRef(
  projectId: string,
  projectPath: string,
): Promise<string> {
  const config = await readShigomoriConfig(projectId).catch(() => null);
  return resolveDefaultBranch(projectPath, config?.defaultBranch);
}

// Worktree mutations (remote syncs and local branch ops) all share the
// same shape: resolve the worktree, run a git action, return the
// freshly-described worktree so the renderer can replace its cached row
// in one round trip.
async function mutateAndDescribe(
  { projectId, worktreeId }: { projectId: string; worktreeId: string },
  action: (target: WorktreeIdentity, project: Project) => Promise<void>,
): Promise<Worktree> {
  // react-doctor-disable-next-line react-doctor/async-parallel -- mutation → refetch is sequential by design
  const { project, worktree } = await findProjectAndWorktreeOrThrow(
    projectId,
    worktreeId,
  );
  await action(worktree, project);
  const refreshed = await findWorktreeIdentityOrThrow(
    project.id,
    project.path,
    worktreeId,
  );
  return describeWorktree(refreshed, project.path);
}
