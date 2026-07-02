import type { WebContents } from "electron";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import type { Handlers } from "@shared/ipc/types";
import {
  isRealBranch,
  type Worktree,
  type WorktreeCarryOverComplete,
  type WorktreeLifecyclePhase,
} from "@shared/schemas";
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
  switchToPrimaryAndDeleteBranch,
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
  convertExternalWorktree,
  createManagedWorktree,
  deleteWorktreeWithCleanup,
  relocateWorktreeToManagedPath,
  setWorktreeShelved,
} from "../../lib/worktrees/operations";
import { broadcast, type HandlerContext } from "../register";
import { scriptEventNotifier } from "../scriptRun";

function notifierFor(sender: WebContents) {
  const notifyPhase = (payload: WorktreeLifecyclePhase) => {
    if (sender.isDestroyed()) return;
    broadcast(worktreesContract, "lifecyclePhase", payload, sender);
  };
  const notifyCarryOverComplete = (payload: WorktreeCarryOverComplete) => {
    if (sender.isDestroyed()) return;
    broadcast(worktreesContract, "carryOverComplete", payload, sender);
  };
  return {
    notifyPhase,
    notifyCarryOverComplete,
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
  switchToPrimaryAndDeleteBranch: (input) =>
    mutateAndDescribe(input, async (wt, pp, target) => {
      if (!isRealBranch(target.branch)) {
        throw new Error("No branch checked out to clean up");
      }
      const primaryRef = await resolvePrimaryRef(target.projectId, pp);
      // Atomic switch + delete: doing this in one main-side call avoids the
      // renderer-side race where the switch unmounts the cleanup box and the
      // chained delete gets dropped (see switchToPrimaryAndDeleteBranch).
      await switchToPrimaryAndDeleteBranch(wt, pp, primaryRef, target.branch);
    }),
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
