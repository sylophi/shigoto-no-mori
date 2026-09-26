import { worktreesContract } from "@shared/ipc/modules/worktrees";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import type { Project, Worktree, WorktreeRemoval } from "@shared/schemas";
import { checkoutBranch, renameBranch } from "@host/lib/git/branches";
import {
  commitStaged,
  discardChanges,
  listChangesForPage,
  readCommitMessage,
  resetSoft,
  restoreDiscard,
  setStaged,
} from "@host/lib/git/changes";
import { getCommitDiff, getFileDiff } from "@host/lib/git/diff";
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
  listWorktreeIdentities,
  listWorktrees,
  type WorktreeIdentity,
} from "@host/lib/git/worktrees";
import {
  findProjectAndWorktreeOrThrow,
  findProjectOrThrow,
  findWorktreePathOrThrow,
} from "@host/lib/projects";
import {
  getInflightDeleteIds,
  getRunningScriptWorktrees,
  withDeleteInflight,
  withDeletesInflight,
} from "@host/lib/scripts";
import { listProjectPullRequests } from "@host/lib/githubCli/pullRequests";
import {
  pullRequestStackFor,
  stackCleanupFor,
  trunkOf,
} from "@shared/pullRequestStack";
import { unknownWorktreeError } from "@shared/errors";
import { readWorktreeFile } from "@host/lib/worktrees/files";
import { scriptEventNotifier } from "../scriptRun";
import {
  adoptViaCli,
  createViaCli,
  deleteStackViaCli,
  deleteViaCli,
  doneViaCli,
  moveViaCli,
  setAutoPullViaCli,
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

// A removal goes to everyone, not just the caller: main installs a
// broadcaster at boot that fans it out to every window and remote
// wire. Before that (and in checks that never mount one) the delete
// is unannounced.
let broadcastRemoval: ((payload: WorktreeRemoval) => void) | null = null;

export function setWorktreeRemovalBroadcaster(
  broadcaster: ((payload: WorktreeRemoval) => void) | null,
): void {
  broadcastRemoval = broadcaster;
}

export const worktreesHandlers: Handlers<
  typeof worktreesContract,
  HandlerContext
> = {
  // The rows are the CLI's (`sm worktrees list`), which also answers
  // an unknown project id with the entity-gone error.
  list: ({ projectId }) => listWorktrees(projectId),

  // Lifecycle mutations route through the bundled CLI so the app and a
  // terminal run the same engine.
  create: async (
    { projectId, worktreeName, branchName, base, checkout },
    ctx,
  ) => {
    const project = await findProjectOrThrow(projectId);
    const input = { worktreeName, branchName, base, checkout };
    return createViaCli(project, input, notifierFor(ctx));
  },

  convertExternal: async ({ projectId, worktreeId }, ctx) => {
    const project = await findProjectOrThrow(projectId);
    return adoptViaCli(project, worktreeId, notifierFor(ctx));
  },

  // `sm worktrees move` moves the checkout and carries what is keyed by
  // its path-derived id (marks, notes, a pending dirty capture) to the
  // new id. What lives in this process stays here: the tombstone that
  // refuses a concurrent delete or move, the reaping of the scripts
  // running there, and the stop of mirrors rooted in it.
  relocate: async ({ projectId, worktreeId, destinationPath }) => {
    const { project, worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    if (worktree.isPrimary) {
      throw new Error("The primary checkout can't be relocated");
    }
    // Already where it should be: refresh the row, and leave its
    // scripts running.
    if (worktree.path === destinationPath) {
      return describeWorktree(project.id, worktreeId);
    }
    return withDeleteInflight(
      worktreeId,
      "This worktree is already being removed or moved.",
      () => moveViaCli(project, worktreeId, destinationPath),
    );
  },

  delete: async (
    { projectId, worktreeId, force, skipCleanup, refuseRunningScripts },
    ctx,
  ) => {
    const project = await findProjectOrThrow(projectId);
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
    // The CLI drops the shelf and auto-pull marks with the worktree.
    // The announcement brackets this call's run only. A second caller
    // is refused up front (withDeleteInflight would refuse it the
    // same way), so its "kept" cannot close the first one's removal
    // under every viewer. The close carries the outcome, so a viewer
    // drops the row exactly when the delete did.
    if (getInflightDeleteIds().has(worktreeId)) {
      throw new Error("This worktree is already being removed.");
    }
    broadcastRemoval?.({ projectId, worktreeId, state: "removing" });
    let removed = false;
    try {
      const result = await withDeleteInflight(
        worktreeId,
        "This worktree is already being removed.",
        () =>
          deleteViaCli(
            project,
            { worktreeId, force, skipCleanup },
            notifierFor(ctx),
          ),
      );
      removed = result.ok;
      return result;
    } finally {
      broadcastRemoval?.({
        projectId,
        worktreeId,
        state: removed ? "removed" : "kept",
      });
    }
  },

  // The merged layers' worktrees of the stack `worktreeId` is in, as
  // one removal. The set is read the way the page reads it (the
  // sidebar's PR map and the listing), so the button's count and the
  // removal agree; the CLI then resolves the stack against GitHub
  // itself and removes what it finds landed. Every worktree of the set
  // is announced and guarded like a single delete, since the one CLI
  // run takes them all.
  deleteStack: async ({ projectId, worktreeId, force }, ctx) => {
    const project = await findProjectOrThrow(projectId);
    const [identities, prs] = await Promise.all([
      listWorktreeIdentities(projectId, { primaryRef: true }),
      listProjectPullRequests(project.path),
    ]);
    const own = identities.find((identity) => identity.id === worktreeId);
    if (!own) throw unknownWorktreeError(worktreeId);
    const stack = pullRequestStackFor(
      Object.fromEntries(prs),
      own.branch,
      trunkOf(identities),
    );
    const cleanup = stack && stackCleanupFor(stack, identities);
    if (!cleanup) {
      throw new Error(
        "No merged layer of this stack has a worktree to remove.",
      );
    }
    const ids = cleanup.worktrees.map((identity) => identity.id);
    if (ids.some((id) => getInflightDeleteIds().has(id))) {
      throw new Error("A worktree of this stack is already being removed.");
    }
    for (const id of ids) {
      broadcastRemoval?.({ projectId, worktreeId: id, state: "removing" });
    }
    let removed: readonly string[] = [];
    try {
      const result = await withDeletesInflight(
        ids,
        "A worktree of this stack is already being removed.",
        () =>
          deleteStackViaCli(
            project,
            { worktreeId: cleanup.target.id, force },
            notifierFor(ctx),
          ),
        (outcome) => outcome.removed,
      );
      removed = result.removed;
      return result;
    } finally {
      for (const id of ids) {
        broadcastRemoval?.({
          projectId,
          worktreeId: id,
          state: removed.includes(id) ? "removed" : "kept",
        });
      }
    }
  },

  setShelved: ({ projectId, worktreeId, shelved }) =>
    mutateAndDescribe({ projectId, worktreeId }, (_target, project) =>
      setShelvedViaCli(project, worktreeId, shelved),
    ),

  // A flag flip only, like setShelved, answered with the refreshed row.
  // The pull itself has one entry point, the fetch scheduler's sweep
  // (main/electron/fetch.ts): the renderer follows a mark with
  // git:refreshProject so the first pull happens right away, through
  // the same path as every later one.
  setAutoPull: async ({ projectId, worktreeId, autoPull }) =>
    setAutoPullViaCli(
      await findProjectOrThrow(projectId),
      worktreeId,
      autoPull,
    ),

  renameBranch: (input) =>
    mutateAndDescribe(input, (wt) => renameBranch(wt.path, input.newBranch)),

  checkoutBranch: (input) =>
    mutateAndDescribe(input, (wt) => checkoutBranch(wt.path, input.branch)),

  fileDiff: async (input) =>
    getFileDiff(
      await findWorktreePathOrThrow(input),
      input.paths,
      input.untracked,
    ),

  readFile: async ({ path, ...input }) =>
    readWorktreeFile(await findWorktreePathOrThrow(input), path),

  changeStatus: async (input) =>
    listChangesForPage(await findWorktreePathOrThrow(input)),

  setStaged: async (input) =>
    setStaged(await findWorktreePathOrThrow(input), input.paths, input.staged),

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

  commitMessage: async (input) =>
    readCommitMessage(await findWorktreePathOrThrow(input), input.hash),

  resetSoft: async (input) => {
    const { result: previousHead, worktree } = await mutateAndDescribeWith(
      input,
      (wt) => resetSoft(wt.path, input.target, input.expectHead),
    );
    return { previousHead, worktree };
  },

  commitDiff: async (input) =>
    getCommitDiff(await findWorktreePathOrThrow(input), input.hash),

  listCommits: async ({ skip, count, ...input }) =>
    listCommits(await findWorktreePathOrThrow(input), { skip, count }),

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
      const { primaryRef } = await findWorktreeIdentityOrThrow(
        project.id,
        target.id,
        { primaryRef: true },
      );
      if (primaryRef === undefined) {
        throw new Error(`No primary branch resolves in ${project.path}`);
      }
      await syncWithPrimary(target.path, project.path, primaryRef);
    }),
  switchToPrimaryAndDeleteBranch: async (input) => {
    const project = await findProjectOrThrow(input.projectId);
    return doneViaCli(project, input.worktreeId);
  },
};

// Worktree mutations (remote syncs, local branch ops, commits) all share
// the same shape: resolve the worktree, run a git action, return the
// freshly-described worktree (the CLI's row) so the renderer can
// replace its cached row in one round trip. The `With` form also hands back what the action
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
  return { result, worktree: await describeWorktree(project.id, worktreeId) };
}

async function mutateAndDescribe(
  scope: { projectId: string; worktreeId: string },
  action: (target: WorktreeIdentity, project: Project) => Promise<void>,
): Promise<Worktree> {
  return (await mutateAndDescribeWith(scope, action)).worktree;
}
