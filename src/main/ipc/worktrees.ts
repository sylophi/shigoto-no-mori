import { basename } from "node:path";
import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import { sanitizeBranchForPath } from "@shared/branches";
import {
  CheckoutBranchPayloadSchema,
  CleanupErrorSchema,
  CommitDiffPayloadSchema,
  ConvertExternalWorktreePayloadSchema,
  type CreateWorktreeResult,
  CreateWorktreePayloadSchema,
  type DeleteWorktreeResult,
  DeleteWorktreePayloadSchema,
  ListWorktreesPayloadSchema,
  RelocateWorktreePayloadSchema,
  RenameBranchPayloadSchema,
  SyncWorktreePayloadSchema,
  type Worktree,
  WorktreeDiffPayloadSchema,
} from "@shared/schemas";
import {
  checkoutBranch,
  createWorktree,
  deleteBranchAfterWorktreeRemoval,
  describeWorktree,
  findWorktreeIdentityOrThrow,
  getCommitDiff,
  getWorktreeDiff,
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
} from "../git";
import { readGlobalConfig } from "../globalConfig";
import { findProjectOrThrow } from "../projects";
import { applyCarryOver } from "../carryOver";
import { killScriptsForWorktree } from "../scripts";
import { readShigomoriConfig } from "../shigomori";
import { runCreateLifecycle, runDeleteCleanup } from "../worktreeLifecycle";
import { pruneEmptyManagedParents } from "../worktreePaths";

export function registerWorktreeHandlers(): void {
  ipcMain.handle(
    CHANNELS.WorktreesList,
    async (_event, rawPayload: unknown): Promise<Worktree[]> => {
      const { projectId } = ListWorktreesPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return listWorktrees(project.id, project.path);
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreesCreate,
    async (event, rawPayload: unknown): Promise<CreateWorktreeResult> => {
      const { projectId, worktreeName, branchName, base, checkout } =
        CreateWorktreePayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      const worktree = await createWorktree(project.id, project.path, {
        requestedWorktreeName: worktreeName,
        branchName,
        base,
        checkout: checkout ?? false,
      });
      const [config, identities, global] = await Promise.all([
        readShigomoriConfig(project.id).catch(() => null),
        listWorktreeIdentities(project.id, project.path),
        readGlobalConfig(),
      ]);
      const carryOver = await applyCarryOver(
        project.path,
        worktree.path,
        config?.carryOver ?? [],
      );

      const projectBranch = identities.find((i) => i.isPrimary)?.branch ?? "";
      const target = identities.find((i) => i.id === worktree.id) ?? worktree;
      const scriptFailures = await runCreateLifecycle({
        project,
        worktree: target,
        projectBranch,
        config,
        globalPortPoolEnabled: global.portPool === true,
        webContents: event.sender,
      });

      return { worktree, carryOver, scriptFailures };
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreesConvertExternal,
    async (event, rawPayload: unknown): Promise<CreateWorktreeResult> => {
      const { projectId, worktreeId } =
        ConvertExternalWorktreePayloadSchema.parse(rawPayload);
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

      const worktree = await createWorktree(project.id, project.path, {
        requestedWorktreeName: worktreeName,
        base: branchOrSha,
        checkout: true,
      });
      const [config, identities, global] = await Promise.all([
        readShigomoriConfig(project.id).catch(() => null),
        listWorktreeIdentities(project.id, project.path),
        readGlobalConfig(),
      ]);
      const carryOver = await applyCarryOver(
        project.path,
        worktree.path,
        config?.carryOver ?? [],
      );

      const projectBranch = identities.find((i) => i.isPrimary)?.branch ?? "";
      const fresh = identities.find((i) => i.id === worktree.id) ?? worktree;
      const scriptFailures = await runCreateLifecycle({
        project,
        worktree: fresh,
        projectBranch,
        config,
        globalPortPoolEnabled: global.portPool === true,
        webContents: event.sender,
      });

      return { worktree, carryOver, scriptFailures };
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreesRelocate,
    async (_event, rawPayload: unknown): Promise<Worktree> => {
      const { projectId, worktreeId, destinationPath } =
        RelocateWorktreePayloadSchema.parse(rawPayload);
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
      await killScriptsForWorktree(worktreeId);
      await relocateWorktree(project.path, target.path, destinationPath);
      // Sweep the old parent dir if it's one we own (managed root's
      // per-project subdir, or the in-project .shigomori scaffolding).
      // The custom layout is deliberately skipped: the directory there
      // is user-chosen and could sit next to unrelated files. Best
      // effort: failures are swallowed so concurrent moves don't race.
      await pruneEmptyManagedParents(target.path, project.path);
      // Everything we need for the moved identity is already known:
      // the id is path-derived, branch/detached survive the move, and we
      // just moved it into a managed prefix the user picked. Skipping
      // the post-move `git worktree list` keeps the relocate batch fast.
      return describeWorktree(
        {
          ...target,
          id: worktreeIdFromPath(destinationPath),
          name: basename(destinationPath),
          path: destinationPath,
          isExternal: false,
        },
        project.path,
      );
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreesDelete,
    async (event, rawPayload: unknown): Promise<DeleteWorktreeResult> => {
      const { projectId, worktreeId, force, skipCleanup } =
        DeleteWorktreePayloadSchema.parse(rawPayload);
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
        try {
          await runDeleteCleanup({
            project,
            worktree: target,
            projectBranch,
            config,
            globalPortPoolEnabled: global.portPool === true,
            webContents: event.sender,
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
      await deleteBranchAfterWorktreeRemoval(
        project.path,
        target,
        global.deleteBranchOnRemove ?? true,
      );
      return { ok: true };
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreesRenameBranch,
    async (_event, rawPayload: unknown): Promise<Worktree> => {
      const { projectId, worktreeId, newBranch } =
        RenameBranchPayloadSchema.parse(rawPayload);
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
  );

  ipcMain.handle(
    CHANNELS.WorktreesCheckoutBranch,
    async (_event, rawPayload: unknown): Promise<Worktree> => {
      const { projectId, worktreeId, branch } =
        CheckoutBranchPayloadSchema.parse(rawPayload);
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
  );

  ipcMain.handle(
    CHANNELS.WorktreesDiff,
    async (_event, rawPayload: unknown): Promise<string> => {
      const { projectId, worktreeId } =
        WorktreeDiffPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      const target = await findWorktreeIdentityOrThrow(
        project.id,
        project.path,
        worktreeId,
      );
      return getWorktreeDiff(target.path);
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreesCommitDiff,
    async (_event, rawPayload: unknown): Promise<string> => {
      const { projectId, worktreeId, hash } =
        CommitDiffPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      const target = await findWorktreeIdentityOrThrow(
        project.id,
        project.path,
        worktreeId,
      );
      return getCommitDiff(target.path, hash);
    },
  );

  // Remote-sync mutations all share the same shape: resolve the worktree,
  // run a git action, return the freshly-described worktree so the
  // renderer can replace its cached row in one round trip.
  const registerSync = (
    channel: string,
    action: (worktreePath: string, projectPath: string) => Promise<void>,
  ) => {
    ipcMain.handle(
      channel,
      async (_event, rawPayload: unknown): Promise<Worktree> => {
        const { projectId, worktreeId } =
          SyncWorktreePayloadSchema.parse(rawPayload);
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
      },
    );
  };

  registerSync(CHANNELS.WorktreesPush, (wt) => pushFastForward(wt));
  registerSync(CHANNELS.WorktreesPull, (wt) => pullFastForward(wt));
  registerSync(CHANNELS.WorktreesPushForce, (wt) => pushForceWithLease(wt));
  registerSync(CHANNELS.WorktreesOverwrite, (wt) => overwriteFromUpstream(wt));
  registerSync(CHANNELS.WorktreesPublish, (wt, pp) =>
    publishCurrentBranch(wt, pp),
  );
  registerSync(CHANNELS.WorktreesPullAndPush, (wt) =>
    pullRebaseOrMergeAndPush(wt),
  );
}
