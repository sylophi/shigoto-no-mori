import { basename } from "node:path";
import type { WebContents } from "electron";
import { sanitizeBranchForPath } from "@shared/branches";
import { worktreesContract } from "@shared/ipc/modules/worktrees/contract";
import { scriptsContract } from "@shared/ipc/modules/scripts/contract";
import type { Handlers } from "@shared/ipc/types";
import {
  CleanupErrorSchema,
  type Project,
  type ScriptEvent,
  type Worktree,
  type WorktreeCarryOverComplete,
  type WorktreeLifecyclePhase,
} from "@shared/schemas";
import { readGlobalConfig } from "../../../lib/config/global";
import {
  deleteWorktreeData,
  readShigomoriConfig,
  readWorktreeData,
  writeWorktreeData,
} from "../../../lib/config/project";
import {
  checkoutBranch,
  createWorktree,
  deleteBranchAfterWorktreeRemoval,
  describeWorktree,
  findWorktreeIdentityOrThrow,
  getCommitDiff,
  getWorktreeDiff,
  listCommits,
  listWorktreeIdentities,
  listWorktrees,
  overwriteFromUpstream,
  publishCurrentBranch,
  pullFastForward,
  pullRebaseOrMergeAndPush,
  pushFastForward,
  pushForceWithLease,
  relocateWorktree,
  removeWorktree,
  removeWorktreeForce,
  renameBranch,
  worktreeIdFromPath,
} from "../../../lib/git";
import { findProjectOrThrow } from "../../../lib/projects";
import { killScriptsForWorktree } from "../../../lib/scripts";
import {
  runCreateLifecycle,
  runDeleteCleanup,
} from "../../../lib/worktrees/lifecycle";
import { pruneEmptyManagedParents } from "../../../lib/worktrees/paths";
import {
  dropShelved,
  isShelved,
  setShelved,
} from "../../../lib/worktrees/shelved";
import { broadcast, type HandlerContext } from "../../register";

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

function spawnCreateLifecycle(
  label: string,
  project: Project,
  worktree: Worktree,
  sender: WebContents,
): void {
  const { notifyPhase, notifyCarryOverComplete, notifyScript } =
    notifierFor(sender);
  void runCreateLifecycle({
    project,
    worktree,
    notifyPhase,
    notifyCarryOverComplete,
    notifyScript,
  }).catch((err) => {
    console.error(`${label} lifecycle failed`, err);
  });
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
    const worktree = await createWorktree(project.id, project.path, {
      requestedWorktreeName: worktreeName,
      branchName,
      base,
      checkout: checkout ?? false,
    });
    // Fire-and-forget so the renderer can navigate to the new worktree
    // instantly. Carry-over, setup, and port-pool provision run in the
    // background; the renderer follows along via WorktreeLifecyclePhase
    // events and the sidebar activity icon driven by ScriptsEvent.
    spawnCreateLifecycle("create", project, worktree, event.sender);
    return { worktree };
  },

  convertExternal: async ({ projectId, worktreeId }, { event }) => {
    const project = findProjectOrThrow(projectId);
    const target = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    if (target.isPrimary) {
      throw new Error("The primary checkout can't be converted");
    }
    if (!target.isExternal) {
      throw new Error("Worktree is already shigomori-managed");
    }

    // The worktree's branch (or short hash, for a detached HEAD) is what
    // we'll re-check-out in the new managed location. Externals were
    // created outside shigomori, so we skip teardown / port-pool release
    // -- we never ran the matching provision on the way in. Force-remove
    // because the whole point of converting is to wipe whatever's in
    // the old directory and start fresh from the branch tip.
    const branchOrSha = target.branch;
    const worktreeName = target.detached
      ? branchOrSha
      : sanitizeBranchForPath(branchOrSha);

    await killScriptsForWorktree(worktreeId);
    await removeWorktreeForce(project.path, target.path);
    dropShelved(worktreeId);

    const worktree = await createWorktree(project.id, project.path, {
      requestedWorktreeName: worktreeName,
      base: branchOrSha,
      checkout: true,
    });
    spawnCreateLifecycle("convert-external", project, worktree, event.sender);
    return { worktree };
  },

  relocate: async ({ projectId, worktreeId, destinationPath }) => {
    const project = findProjectOrThrow(projectId);
    const target = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    if (target.isPrimary) {
      throw new Error("The primary checkout can't be relocated");
    }
    if (target.path === destinationPath) {
      // Already where it should be; refresh the row but skip the move.
      return describeWorktree(target, project.path);
    }
    // Reap scripts running with the old worktree as cwd before the
    // move. Otherwise the process keeps running in the moved directory
    // while the renderer drops the run state on success, leaving an
    // unmanageable child until app quit. Matches the delete handler.
    const [, carryData] = await Promise.all([
      killScriptsForWorktree(worktreeId),
      readWorktreeData(project.id, worktreeId),
    ]);
    // The id is path-derived, so the relocate changes it -- carry the
    // shelf flag and per-worktree state forward to the new id.
    const carryShelved = isShelved(worktreeId);
    await relocateWorktree(project.path, target.path, destinationPath);
    // Sweep the old parent dir if it's one we own (managed root's
    // per-project subdir, or the in-project .shigomori scaffolding).
    // The custom layout is deliberately skipped: the directory there
    // is user-chosen and could sit next to unrelated files. Best
    // effort: failures are swallowed so concurrent moves don't race.
    await pruneEmptyManagedParents(target.path, project.path);
    const newId = worktreeIdFromPath(destinationPath);
    if (carryShelved) {
      dropShelved(worktreeId);
      setShelved(newId, true);
    }
    if (carryData) {
      await Promise.all([
        writeWorktreeData(project.id, newId, carryData),
        deleteWorktreeData(project.id, worktreeId),
      ]);
    }
    // Everything we need for the moved identity is already known:
    // the id is path-derived, branch/detached survive the move, and we
    // just moved it into a managed prefix the user picked. Skipping
    // the post-move `git worktree list` keeps the relocate batch fast.
    return describeWorktree(
      {
        ...target,
        id: newId,
        name: basename(destinationPath),
        path: destinationPath,
        isExternal: false,
      },
      project.path,
    );
  },

  delete: async ({ projectId, worktreeId, force, skipCleanup }, { event }) => {
    const project = findProjectOrThrow(projectId);
    const target = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    if (target.isPrimary) {
      throw new Error("Cannot delete the project's primary worktree");
    }
    if (!force) {
      const full = await describeWorktree(target, project.path);
      if (full.changedCount > 0) {
        throw new Error(
          `Worktree has ${full.changedCount} uncommitted change(s). Pass force=true to remove anyway.`,
        );
      }
    }

    const global = await readGlobalConfig();

    // Cleanup runs even on force-delete (force only bypasses the
    // uncommitted-changes guard, not teardown / port-pool release).
    // External worktrees were created outside shigomori, so we never
    // ran setup or port-pool provision for them -- skip the symmetric
    // teardown / release so we don't touch state we don't own.
    // Electron's IPC strips structured properties off thrown errors,
    // so we surface cleanup failures as a returned discriminated
    // result instead -- the renderer's UI uses it to drive the
    // retry/skip affordance.
    if (skipCleanup !== true && !target.isExternal) {
      const [config, identities] = await Promise.all([
        readShigomoriConfig(project.id).catch(() => null),
        listWorktreeIdentities(project.id, project.path),
      ]);
      const projectBranch = identities.find((i) => i.isPrimary)?.branch ?? "";
      const { notifyScript } = notifierFor(event.sender);
      try {
        await runDeleteCleanup({
          project,
          worktree: target,
          projectBranch,
          config,
          globalPortPoolEnabled: global.portPool === true,
          notifyScript,
        });
      } catch (err) {
        const parsed = CleanupErrorSchema.safeParse(err);
        if (parsed.success) {
          return { ok: false, cleanupError: parsed.data };
        }
        throw err;
      }
    }

    // Reap any package scripts still holding the worktree as cwd,
    // then remove. Force-delete routes through the wipe fallback so
    // ENOTEMPTY (untracked content git couldn't sweep) doesn't strand
    // the user with a half-removed worktree.
    await killScriptsForWorktree(worktreeId);
    if (force) {
      await removeWorktreeForce(project.path, target.path);
    } else {
      await removeWorktree(project.path, target.path, false);
    }
    // Same cleanup as relocate: if this was the last worktree under a
    // managed parent, sweep the empty dir away. Custom paths are left
    // alone since they're user-chosen.
    if (!target.isExternal) {
      await pruneEmptyManagedParents(target.path, project.path);
    }

    // Defaults to true: if you're done with the worktree, you're done
    // with the local branch. (Remote branches are never touched.)
    dropShelved(worktreeId);
    await Promise.all([
      deleteBranchAfterWorktreeRemoval(
        project.path,
        target,
        global.deleteBranchOnRemove ?? true,
      ),
      deleteWorktreeData(project.id, worktreeId),
    ]);
    return { ok: true };
  },

  setShelved: async ({ projectId, worktreeId, shelved }) => {
    const project = findProjectOrThrow(projectId);
    const target = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    if (shelved && (target.isPrimary || target.isExternal)) {
      throw new Error(
        target.isPrimary
          ? "The primary checkout can't be shelved"
          : "External worktrees can't be shelved",
      );
    }
    setShelved(worktreeId, shelved);
    return describeWorktree(target, project.path);
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
};

// Remote-sync mutations all share the same shape: resolve the worktree,
// run a git action, return the freshly-described worktree so the
// renderer can replace its cached row in one round trip.
async function syncWorktree(
  { projectId, worktreeId }: { projectId: string; worktreeId: string },
  action: (worktreePath: string, projectPath: string) => Promise<void>,
): Promise<Worktree> {
  const project = findProjectOrThrow(projectId);
  const target = await findWorktreeIdentityOrThrow(
    project.id,
    project.path,
    worktreeId,
  );
  await action(target.path, project.path);
  const refreshed = await findWorktreeIdentityOrThrow(
    project.id,
    project.path,
    worktreeId,
  );
  return describeWorktree(refreshed, project.path);
}
