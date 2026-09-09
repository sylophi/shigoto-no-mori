import type { WebContents } from "electron";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import type { Handlers } from "@shared/ipc/types";
import type { Project, Worktree } from "@shared/schemas";
import { readShigomoriConfig } from "../../lib/config/project";
import { checkoutBranch, renameBranch } from "../../lib/git/branches";
import {
  commitStaged,
  discardChanges,
  listChangesForPage,
  readCommitMessage,
  resetSoft,
  restoreDiscard,
  setStaged,
} from "../../lib/git/changes";
import { getCommitDiff, getFileDiff } from "../../lib/git/diff";
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
import {
  findProjectAndWorktreeOrThrow,
  findProjectOrThrow,
} from "../../lib/projects";
import { withDeleteInflight } from "../../lib/scripts";
import { relocateWorktreeToManagedPath } from "../../lib/worktrees/relocate";
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
    // The CLI can't see the app's script registry, so the delete runs
    // under the shared tombstone protocol (see withDeleteInflight).
    return withDeleteInflight(
      worktreeId,
      "This worktree is already being removed.",
      () =>
        deleteViaCli(
          project,
          { worktreeId, force, skipCleanup },
          notifierFor(event.sender),
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

  fileDiff: async ({ projectId, worktreeId, paths, untracked }) => {
    const { worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    return getFileDiff(worktree.path, paths, untracked);
  },

  changeStatus: async ({ projectId, worktreeId }) => {
    const { worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    return listChangesForPage(worktree.path);
  },

  setStaged: async ({ projectId, worktreeId, paths, staged }) => {
    const { worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    return setStaged(worktree.path, paths, staged);
  },

  commit: async (input) => {
    const { result: hash, worktree } = await mutateAndDescribeWith(
      input,
      (wt) => commitStaged(wt.path, input),
    );
    return { hash, worktree };
  },

  discardChanges: async (input) => {
    const { result: snapshot, worktree } = await mutateAndDescribeWith(
      input,
      (wt) => discardChanges(wt.path, input.paths),
    );
    return { snapshot, worktree };
  },

  restoreDiscard: (input) =>
    mutateAndDescribe(input, (wt) => restoreDiscard(wt.path, input.snapshot)),

  commitMessage: async ({ projectId, worktreeId, hash }) => {
    const { worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    return readCommitMessage(worktree.path, hash);
  },

  resetSoft: async (input) => {
    const { result: previousHead, worktree } = await mutateAndDescribeWith(
      input,
      (wt) => resetSoft(wt.path, input.target, input.expectHead),
    );
    return { previousHead, worktree };
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

// Worktree mutations (remote syncs, local branch ops, commits) all share
// the same shape: resolve the worktree, run a git action, return the
// freshly-described worktree so the renderer can replace its cached row
// in one round trip. The `With` form also hands back what the action
// produced (a commit hash, a snapshot ref) for the calls that have one.
async function mutateAndDescribeWith<T>(
  { projectId, worktreeId }: { projectId: string; worktreeId: string },
  action: (target: WorktreeIdentity, project: Project) => Promise<T>,
): Promise<{ result: T; worktree: Worktree }> {
  // react-doctor-disable-next-line react-doctor/async-parallel -- mutation → refetch is sequential by design
  const { project, worktree } = await findProjectAndWorktreeOrThrow(
    projectId,
    worktreeId,
  );
  const result = await action(worktree, project);
  const refreshed = await findWorktreeIdentityOrThrow(
    project.id,
    project.path,
    worktreeId,
  );
  return { result, worktree: await describeWorktree(refreshed, project.path) };
}

async function mutateAndDescribe(
  scope: { projectId: string; worktreeId: string },
  action: (target: WorktreeIdentity, project: Project) => Promise<void>,
): Promise<Worktree> {
  return (await mutateAndDescribeWith(scope, action)).worktree;
}
