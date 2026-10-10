import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/views";
import { gitContract } from "@shigomori/contracts/modules/git";
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import type {
  Project,
  Worktree,
  WorktreeRemoval,
} from "@shigomori/contracts/schemas";
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
import {
  getCommitDiff,
  getFileDiff,
  getMergeBaseDiff,
} from "@host/lib/git/diff";
import {
  cherryPickCommit,
  revertCommit,
  rewordCommit,
  squashIntoParent,
} from "@host/lib/git/history";
import {
  discardHunks,
  readHunkStates,
  setHunksStaged,
} from "@host/lib/git/hunks";
import {
  applyStash,
  dropStash,
  listStashes,
  readStashDiff,
  restoreStash,
  stashChanges,
} from "@host/lib/git/stash";
import {
  abortOperation,
  continueOperation,
  readOperation,
  resolveConflict,
} from "@host/lib/git/operation";
import { mergeBranch, readMergePreview } from "@host/lib/git/merge";
import {
  mergePrimaryKeepingConflicts,
  mergeUpstreamKeepingConflicts,
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
  readBranchHistory,
  type WorktreeIdentity,
} from "@host/lib/git/worktrees";
import {
  findProjectAndWorktreeOrThrow,
  findProjectOrThrow,
  findWorktreePathOrThrow,
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
} from "@shared/pullRequestStack";
import { UnknownWorktreeError } from "@shigomori/contracts/errors";
import { readWorktreeFile } from "@host/lib/worktrees/files";
import { openTerminals } from "@host/lib/terminals/Terminals";
import { isSameOrInside } from "@shared/git/worktreeLayout";
import {
  moveMirrorsOfWorktree,
  stopMirrorsForWorktree,
} from "@host/mirror/registry";
import { scriptEventNotifier } from "../scriptRun";
import {
  adoptWorktree,
  createWorktree,
  deleteStack,
  deleteWorktree,
  finishWorktree,
  idleAgents,
  moveWorktree,
  renameWorktree,
  resumeAgent,
  setAutoPull,
  setShelved,
  unbindAgent,
} from "@host/lib/engineCalls";

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

const gitMoved = (projectId: string) =>
  Views.either(
    Views.pushed(gitContract, "projectChanged", (moved) => {
      return moved.projectId === projectId;
    }),
    Views.pushed(gitContract, "refsRefreshed", (fetched) => {
      return fetched.projectId === projectId;
    }),
  );

const counted = (n: number, noun: string) =>
  n === 0 ? [] : [`${n} ${noun}${n === 1 ? "" : "s"}`];

// The scripts and terminals running in a worktree hold its folder, so a
// move or a rename waits until they are stopped.
async function refuseRunningWork(
  worktree: { id: string; name: string; path: string },
  verb: "move" | "rename",
): Promise<void> {
  const scripts =
    getRunningScriptWorktrees().find(
      (entry) => entry.worktreeId === worktree.id,
    )?.scriptCount ?? 0;
  const terminals = (await openTerminals()).filter(({ owner, cwd }) =>
    owner.kind === "worktree"
      ? owner.worktreeId === worktree.id
      : isSameOrInside(cwd, worktree.path),
  ).length;
  const running = [
    ...counted(scripts, "script"),
    ...counted(terminals, "terminal"),
  ];
  if (running.length === 0) return;
  const one = scripts + terminals === 1;
  throw new Error(
    `Can't ${verb} ${worktree.name} while ${running.join(" and ")} ${one ? "is" : "are"} running there. Stop ${one ? "it" : "them"} first.`,
  );
}

export const worktreesViews: ViewHandlers<
  typeof worktreesContract,
  Views.Services
> = {
  watch: ({ projectId }) =>
    Views.view(
      () => listWorktrees(projectId),
      Views.either(
        Views.wrote(
          "projects",
          "project_config",
          "worktree_marks",
          "shelf_snapshots",
          "worktree_data",
          "agent_sessions",
        ),
        gitMoved(projectId),
      ),
    ),
  // A file edited in the worktree moves no ref and writes no row, so the
  // list is also read again every few seconds.
  watchChangeStatus: (input) =>
    Views.view(
      async () => listChangesForPage(await findWorktreePathOrThrow(input)),
      Views.either(
        gitMoved(input.projectId),
        Views.pushed(mirrorContract, "gitChanged", (staged) => {
          return staged.worktreeId === input.worktreeId;
        }),
      ),
      { every: "2 seconds" },
    ),
};

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
    { projectId, worktreeName, branchName, base, checkout, cloneFiles },
    ctx,
  ) => {
    const project = await findProjectOrThrow(projectId);
    const input = { worktreeName, branchName, base, checkout, cloneFiles };
    return createWorktree(project, input, notifierFor(ctx));
  },

  // A renderer from before the field sends none and expects the force
  // it always got, so only an explicit false runs unforced.
  convertExternal: async ({ projectId, worktreeId, force }, ctx) => {
    const project = await findProjectOrThrow(projectId);
    return adoptWorktree(
      project,
      worktreeId,
      force !== false,
      notifierFor(ctx),
    );
  },

  // `sm worktrees move` moves the checkout and carries what is keyed by
  // its path-derived id to the new id. What lives in this process stays
  // here: the running work it refuses, the tombstone that refuses a
  // concurrent delete or move, and the mirrors rooted in it, re-opened
  // on the new path.
  relocate: async ({ projectId, worktreeId, destinationPath }) => {
    const { project, worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    if (worktree.isPrimary) {
      throw new Error("The primary checkout can't be relocated");
    }
    // Already where it should be: refresh the row.
    if (worktree.path === destinationPath) {
      return describeWorktree(project.id, worktreeId);
    }
    await refuseRunningWork(worktree, "move");
    return withDeleteInflight(
      worktreeId,
      "This worktree is already being removed or moved.",
      () => moveWorktree(project, worktreeId, destinationPath),
      (moved) => moveMirrorsOfWorktree(worktreeId, moved),
    );
  },

  // A move to the same parent under a new name, with a move's guards.
  rename: async ({ projectId, worktreeId, name }) => {
    const { project, worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    if (worktree.name === name) return describeWorktree(project.id, worktreeId);
    await refuseRunningWork(worktree, "rename");
    return withDeleteInflight(
      worktreeId,
      "This worktree is already being removed or moved.",
      () => renameWorktree(project, worktreeId, name),
      (renamed) => moveMirrorsOfWorktree(worktreeId, renamed),
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
    assertWorktreeMutable(
      worktreeId,
      "This worktree is already being removed.",
    );
    broadcastRemoval?.({ projectId, worktreeId, state: "removing" });
    let removed = false;
    try {
      const result = await withDeleteInflight(
        worktreeId,
        "This worktree is already being removed.",
        () =>
          deleteWorktree(
            project,
            { worktreeId, force, skipCleanup },
            notifierFor(ctx),
          ),
        (outcome) =>
          outcome.ok ? stopMirrorsForWorktree(worktreeId) : Promise.resolve(),
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
  // one removal. The set is read the way the page reads it (the PR map
  // and the listing), off a fresh sweep of the PRs so it is what the
  // CLI, which resolves the stack against GitHub itself, finds landed
  // too. Every worktree of the set is announced and guarded like a
  // single delete, since the one CLI run takes them all. One the CLI
  // took past the set (a layer that landed in the moment between) gets
  // its scripts reaped and its removal announced once it is gone.
  deleteStack: async ({ projectId, worktreeId, force, skipCleanup }, ctx) => {
    const project = await findProjectOrThrow(projectId);
    const [identities, prs] = await Promise.all([
      listWorktreeIdentities(projectId, { primaryRef: true }),
      refreshProjectPullRequests(project.path),
    ]);
    const own = identities.find((identity) => identity.id === worktreeId);
    if (!own) throw new UnknownWorktreeError({ worktreeId });
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
    const busy = "A worktree of this stack is already being removed.";
    for (const id of ids) assertWorktreeMutable(id, busy);
    for (const id of ids) {
      broadcastRemoval?.({ projectId, worktreeId: id, state: "removing" });
    }
    let removed: readonly string[] = [];
    try {
      const result = await withDeletesInflight(
        ids,
        busy,
        () =>
          deleteStack(
            project,
            { worktreeId: cleanup.target.id, force, skipCleanup },
            notifierFor(ctx),
          ),
        (outcome) => Promise.all(outcome.removed.map(stopMirrorsForWorktree)),
      );
      removed = result.removed;
      await Promise.all(
        removed
          .filter((id) => !ids.includes(id))
          .map((id) => killScriptsForWorktree(id)),
      );
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
      setShelved(project, worktreeId, shelved),
    ),

  // A flag flip only, like setShelved, answered with the refreshed row.
  // The pull itself has one entry point, the fetch scheduler's sweep
  // (main/electron/fetch.ts): the renderer follows a mark with
  // git:refreshProject so the first pull happens right away, through
  // the same path as every later one.
  setAutoPull: async ({ projectId, worktreeId, autoPull }) =>
    setAutoPull(await findProjectOrThrow(projectId), worktreeId, autoPull),

  idleAgents: async ({ projectId, worktreeId }) =>
    idleAgents(await findProjectOrThrow(projectId), worktreeId),

  unbindAgent: async ({ projectId, worktreeId, harness, session }) =>
    unbindAgent(
      await findProjectOrThrow(projectId),
      worktreeId,
      harness,
      session,
    ),

  resumeAgent: async ({ projectId, worktreeId, harness, session }) =>
    resumeAgent(
      await findProjectOrThrow(projectId),
      worktreeId,
      harness,
      session,
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

  fileHunks: async (input) =>
    readHunkStates(await findWorktreePathOrThrow(input), input.path),
  setHunksStaged: async (input) =>
    setHunksStaged(
      await findWorktreePathOrThrow(input),
      input.path,
      input.changes,
      input.staged,
    ),
  discardHunks: async (input) => {
    const { result: snapshot, worktree } = await mutateAndDescribeWith(
      input,
      (wt) => discardHunks(wt.path, input.path, input.changes),
    );
    return { snapshot, worktree };
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

  listCommits: async ({ skip, count, query, from, ...input }) =>
    listCommits(await findWorktreePathOrThrow(input), {
      skip,
      count,
      query,
      from,
    }),

  branchHistory: async (input) => {
    const identity = await findWorktreeIdentityOrThrow(
      input.projectId,
      input.worktreeId,
      { primaryRef: true },
    );
    return readBranchHistory(identity.path, {
      base: branchBaseOf(identity),
      count: BRANCH_HISTORY_COUNT,
    });
  },

  branchDiff: async (input) => {
    const identity = await findWorktreeIdentityOrThrow(
      input.projectId,
      input.worktreeId,
      { primaryRef: true },
    );
    const base = branchBaseOf(identity);
    if (base === undefined) {
      throw new Error("This branch has no primary branch to compare with.");
    }
    return getMergeBaseDiff(identity.path, base, "HEAD");
  },

  revertCommit: (input) =>
    mutateAndDescribe(input, (wt) => revertCommit(wt.path, input.hash)),
  cherryPick: (input) =>
    mutateAndDescribe(input, (wt) => cherryPickCommit(wt.path, input.hash)),
  rewordCommit: (input) =>
    mutateAndDescribe(input, (wt) =>
      rewordCommit(wt.path, input.hash, input, input.expectHead),
    ),
  squashCommit: (input) =>
    mutateAndDescribe(input, (wt) =>
      squashIntoParent(wt.path, input.hash, input.expectHead),
    ),

  stashes: async (input) => {
    const { worktree } = await findProjectAndWorktreeOrThrow(
      input.projectId,
      input.worktreeId,
    );
    return worktree.detached ? [] : listStashes(worktree.path, worktree.branch);
  },
  stashDiff: async (input) =>
    readStashDiff(await findWorktreePathOrThrow(input), input.hash),
  stashChanges: (input) =>
    mutateAndDescribe(input, (wt) => stashChanges(wt.path, input.message)),
  applyStash: (input) =>
    mutateAndDescribe(input, (wt) =>
      applyStash(wt.path, input.hash, input.drop),
    ),
  dropStash: async (input) =>
    dropStash(await findWorktreePathOrThrow(input), input.hash),
  restoreStash: async (input) => {
    const { worktree } = await findProjectAndWorktreeOrThrow(
      input.projectId,
      input.worktreeId,
    );
    await restoreStash(worktree.path, worktree.branch, input.hash, input);
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
      const primaryRef = await primaryRefToSync(target, project);
      await syncWithPrimary(target.path, project.path, primaryRef);
    }),
  mergePrimary: async (input) => {
    const { result, worktree } = await mutateAndDescribeWith(
      input,
      async (target, project) =>
        mergePrimaryKeepingConflicts(
          target.path,
          project.path,
          await primaryRefToSync(target, project),
        ),
    );
    return { worktree, stopped: result };
  },

  mergeUpstream: async (input) => {
    const { result, worktree } = await mutateAndDescribeWith(input, (wt) =>
      mergeUpstreamKeepingConflicts(wt.path),
    );
    return { worktree, stopped: result };
  },

  operation: async (input) =>
    readOperation(await findWorktreePathOrThrow(input)),
  resolveConflict: (input) =>
    mutateAndDescribe(input, (wt) =>
      resolveConflict(wt.path, input.path, input.side),
    ),
  mergePreview: async (input) =>
    readMergePreview(await findWorktreePathOrThrow(input), input.ref),
  mergeBranch: async (input) => {
    const { result, worktree } = await mutateAndDescribeWith(input, (wt) =>
      mergeBranch(wt.path, input.ref, input.method, input.message),
    );
    return { worktree, stopped: result };
  },
  continueOperation: (input) =>
    mutateAndDescribe(input, (wt) => continueOperation(wt.path)),
  abortOperation: (input) =>
    mutateAndDescribe(input, (wt) => abortOperation(wt.path)),
  switchToPrimaryAndDeleteBranch: async (input) => {
    const project = await findProjectOrThrow(input.projectId);
    return finishWorktree(project, input.worktreeId);
  },
};

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
async function primaryRefToSync(
  target: WorktreeIdentity,
  project: Project,
): Promise<string> {
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
  return primaryRef;
}

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
