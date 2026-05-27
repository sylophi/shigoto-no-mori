import type { WebContents } from "electron";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import type { Handlers } from "@shared/ipc/types";
import {
  type ScriptEvent,
  type Worktree,
  type WorktreeCarryOverComplete,
  type WorktreeLifecyclePhase,
} from "@shared/schemas";
import { readShigomoriConfig } from "../../lib/config/project";
import {
  checkoutBranch,
  describeWorktree,
  findWorktreeIdentityOrThrow,
  getCommitDiff,
  getWorktreeDiff,
  listCommits,
  listWorktrees,
  overwriteFromUpstream,
  publishCurrentBranch,
  pullFastForward,
  pullRebaseOrMergeAndPush,
  pushFastForward,
  pushForceWithLease,
  renameBranch,
  resolveDefaultBranch,
  syncWithPrimary,
  type WorktreeIdentity,
} from "../../lib/git";
import { findProjectOrThrow } from "../../lib/projects";
import {
  convertExternalWorktree,
  createManagedWorktree,
  deleteWorktreeWithCleanup,
  relocateWorktreeToManagedPath,
  setWorktreeShelved,
} from "../../lib/worktrees/operations";
import { broadcast, type HandlerContext } from "../register";

function notifierFor(sender: WebContents) {
  const notifyPhase = (payload: WorktreeLifecyclePhase) => {
    if (sender.isDestroyed()) return;
    broadcast(worktreesContract, "lifecyclePhase", payload, sender);
  };
  const notifyCarryOverComplete = (payload: WorktreeCarryOverComplete) => {
    if (sender.isDestroyed()) return;
    broadcast(worktreesContract, "carryOverComplete", payload, sender);
  };
  const notifyScript = (payload: ScriptEvent) => {
    if (sender.isDestroyed()) return;
    broadcast(scriptsContract, "event", payload, sender);
  };
  return { notifyPhase, notifyCarryOverComplete, notifyScript };
}

export const worktreesHandlers: Handlers<
  typeof worktreesContract,
  HandlerContext
> = {
  list: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return listWorktrees(project.id, project.path);
  },

  create: async (
    { projectId, worktreeName, branchName, base, checkout },
    { event },
  ) => {
    const project = findProjectOrThrow(projectId);
    return createManagedWorktree(
      project,
      {
        worktreeName,
        branchName,
        base,
        checkout,
      },
      notifierFor(event.sender),
    );
  },

  convertExternal: async ({ projectId, worktreeId }, { event }) => {
    const project = findProjectOrThrow(projectId);
    return convertExternalWorktree(
      project,
      worktreeId,
      notifierFor(event.sender),
    );
  },

  relocate: async ({ projectId, worktreeId, destinationPath }) => {
    const project = findProjectOrThrow(projectId);
    return relocateWorktreeToManagedPath(project, worktreeId, destinationPath);
  },

  delete: async ({ projectId, worktreeId, force, skipCleanup }, { event }) => {
    const project = findProjectOrThrow(projectId);
    return deleteWorktreeWithCleanup(
      project,
      { worktreeId, force, skipCleanup },
      notifierFor(event.sender),
    );
  },

  setShelved: async ({ projectId, worktreeId, shelved }) => {
    const project = findProjectOrThrow(projectId);
    return setWorktreeShelved(project, worktreeId, shelved);
  },

  renameBranch: async ({ projectId, worktreeId, newBranch }) => {
    const project = findProjectOrThrow(projectId);
    const target = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    await renameBranch(target.path, newBranch);
    const refreshed = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    return describeWorktree(refreshed, project.path);
  },

  checkoutBranch: async ({ projectId, worktreeId, branch }) => {
    const project = findProjectOrThrow(projectId);
    const target = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    await checkoutBranch(target.path, branch);
    const refreshed = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    return describeWorktree(refreshed, project.path);
  },

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

  push: (input) => syncWorktree(input, (wt) => pushFastForward(wt)),
  pull: (input) => syncWorktree(input, (wt) => pullFastForward(wt)),
  pushForce: (input) => syncWorktree(input, (wt) => pushForceWithLease(wt)),
  overwrite: (input) => syncWorktree(input, (wt) => overwriteFromUpstream(wt)),
  publish: (input) =>
    syncWorktree(input, (wt, pp) => publishCurrentBranch(wt, pp)),
  pullAndPush: (input) =>
    syncWorktree(input, (wt) => pullRebaseOrMergeAndPush(wt)),
  syncWithPrimary: (input) =>
    syncWorktree(input, async (wt, pp, target) => {
      if (target.isPrimary) {
        throw new Error("The primary checkout can't be synced from itself");
      }
      if (target.detached) {
        throw new Error(
          "Detached worktrees can't be synced with the primary branch",
        );
      }
      const config = await readShigomoriConfig(target.projectId).catch(
        () => null,
      );
      const primaryRef = await resolveDefaultBranch(pp, config?.defaultBranch);
      await syncWithPrimary(wt, pp, primaryRef);
    }),
};

// Remote-sync mutations all share the same shape: resolve the worktree,
// run a git action, return the freshly-described worktree so the
// renderer can replace its cached row in one round trip.
async function syncWorktree(
  { projectId, worktreeId }: { projectId: string; worktreeId: string },
  action: (
    worktreePath: string,
    projectPath: string,
    target: WorktreeIdentity,
  ) => Promise<void>,
): Promise<Worktree> {
  const project = findProjectOrThrow(projectId);
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
