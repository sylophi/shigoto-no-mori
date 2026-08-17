import type { WebContents } from "electron";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import type { Handlers } from "@shared/ipc/types";
import type { Worktree } from "@shared/schemas";
import { readShigomoriConfig } from "../../lib/config/project";
import { checkoutBranch, renameBranch } from "../../lib/git/branches";
import { getCommitDiff, getWorktreeDiff } from "../../lib/git/diff";
import { resolveDefaultBranch } from "../../lib/git/remotes";
import {
  overwriteFromUpstream,
  publishCurrentBranch,
  pullFastForward,
  pullRebaseOrMergeAndPush,
  pushFastForward,
  pushForceWithLease,
  syncWithPrimary,
} from "../../lib/git/sync";
import {
  describeWorktree,
  findWorktreeIdentityOrThrow,
  listCommits,
  listWorktrees,
  type WorktreeIdentity,
} from "../../lib/git/worktrees";
import { findProjectOrThrow } from "../../lib/projects";
import {
  clearDeleteInflight,
  getInflightDeleteIds,
  killScriptsForWorktree,
  markDeleteInflight,
} from "../../lib/scripts";
import { relocateWorktreeToManagedPath } from "../../lib/worktrees/operations";
import { guardedNotifier, type HandlerContext } from "../register";
import { scriptEventNotifier } from "../scriptRun";
import {
  adoptViaCli,
  createViaCli,
  deleteViaCli,
  doneViaCli,
  setShelvedViaCli,
} from "../cliDelegate";

function notifierFor(sender: WebContents) {
  return {
    notifyPhase: guardedNotifier(worktreesContract, "lifecyclePhase", sender),
    notifyCarryOverComplete: guardedNotifier(
      worktreesContract,
      "carryOverComplete",
      sender,
    ),
    notifyScript: scriptEventNotifier(sender),
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
    { event },
  ) => {
    const project = findProjectOrThrow(projectId);
    const input = { worktreeName, branchName, base, checkout };
    return createViaCli(project, input, notifierFor(event.sender));
  },

  convertExternal: async ({ projectId, worktreeId }, { event }) => {
    const project = findProjectOrThrow(projectId);
    return adoptViaCli(project, worktreeId, notifierFor(event.sender));
  },

  relocate: async ({ projectId, worktreeId, destinationPath }) => {
    const project = findProjectOrThrow(projectId);
    return relocateWorktreeToManagedPath(project, worktreeId, destinationPath);
  },

  delete: async ({ projectId, worktreeId, force, skipCleanup }, { event }) => {
    const project = findProjectOrThrow(projectId);
    // The CLI can't see the app's script registry, so around its run we
    // refuse a duplicate delete, tombstone the id so a still-running
    // create lifecycle can't spawn steps into the vanishing directory,
    // and reap app-spawned scripts first (a dev server would otherwise
    // outlive its worktree).
    if (getInflightDeleteIds().has(worktreeId)) {
      throw new Error("This worktree is already being removed.");
    }
    markDeleteInflight(worktreeId);
    try {
      await killScriptsForWorktree(worktreeId);
      return await deleteViaCli(
        project,
        { worktreeId, force, skipCleanup },
        notifierFor(event.sender),
      );
    } finally {
      clearDeleteInflight(worktreeId);
    }
  },

  setShelved: async ({ projectId, worktreeId, shelved }) => {
    const project = findProjectOrThrow(projectId);
    return mutateAndDescribe({ projectId, worktreeId }, () =>
      setShelvedViaCli(project, worktreeId, shelved),
    );
  },

  renameBranch: (input) =>
    mutateAndDescribe(input, (wt) => renameBranch(wt, input.newBranch)),

  checkoutBranch: (input) =>
    mutateAndDescribe(input, (wt) => checkoutBranch(wt, input.branch)),

  diff: async ({ projectId, worktreeId }) => {
    const project = findProjectOrThrow(projectId);
    const target = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    return getWorktreeDiff(target.path);
  },

  commitDiff: async ({ projectId, worktreeId, hash }) => {
    const project = findProjectOrThrow(projectId);
    const target = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    return getCommitDiff(target.path, hash);
  },

  listCommits: async ({ projectId, worktreeId, skip, count }) => {
    const project = findProjectOrThrow(projectId);
    const target = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    return listCommits(target.path, { skip, count });
  },

  push: (input) => mutateAndDescribe(input, (wt) => pushFastForward(wt)),
  pull: (input) => mutateAndDescribe(input, (wt) => pullFastForward(wt)),
  pushForce: (input) =>
    mutateAndDescribe(input, (wt) => pushForceWithLease(wt)),
  overwrite: (input) =>
    mutateAndDescribe(input, (wt) => overwriteFromUpstream(wt)),
  publish: (input) =>
    mutateAndDescribe(input, (wt, pp) => publishCurrentBranch(wt, pp)),
  pullAndPush: (input) =>
    mutateAndDescribe(input, (wt) => pullRebaseOrMergeAndPush(wt)),
  syncWithPrimary: (input) =>
    mutateAndDescribe(input, async (wt, pp, target) => {
      if (target.isPrimary) {
        throw new Error("The primary checkout can't be synced from itself");
      }
      if (target.detached) {
        throw new Error(
          "Detached worktrees can't be synced with the primary branch",
        );
      }
      const primaryRef = await resolvePrimaryRef(target.projectId, pp);
      await syncWithPrimary(wt, pp, primaryRef);
    }),
  switchToPrimaryAndDeleteBranch: async (input) => {
    const project = findProjectOrThrow(input.projectId);
    return doneViaCli(project, input.worktreeId);
  },
};

// Resolve the project's primary ref, honoring the configured override.
// Shared by the sync-from-primary and switch-to-primary handlers.
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
  action: (
    worktreePath: string,
    projectPath: string,
    target: WorktreeIdentity,
  ) => Promise<void>,
): Promise<Worktree> {
  const project = findProjectOrThrow(projectId);
  // react-doctor-disable-next-line react-doctor/async-parallel -- mutation → refetch is sequential by design
  const target = await findWorktreeIdentityOrThrow(
    project.id,
    project.path,
    worktreeId,
  );
  await action(target.path, project.path, target);
  const refreshed = await findWorktreeIdentityOrThrow(
    project.id,
    project.path,
    worktreeId,
  );
  return describeWorktree(refreshed, project.path);
}
