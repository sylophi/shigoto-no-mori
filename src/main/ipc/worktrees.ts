import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  CheckoutBranchPayloadSchema,
  CleanupErrorSchema,
  CommitDiffPayloadSchema,
  type CreateWorktreeResult,
  CreateWorktreePayloadSchema,
  type DeleteWorktreeResult,
  DeleteWorktreePayloadSchema,
  isRealBranch,
  ListWorktreesPayloadSchema,
  RenameBranchPayloadSchema,
  type Worktree,
  WorktreeDiffPayloadSchema,
} from "@shared/schemas";
import {
  checkoutBranch,
  createWorktree,
  deleteLocalBranch,
  describeWorktree,
  findWorktreeIdentityOrThrow,
  getCommitDiff,
  getWorktreeDiff,
  listWorktreeIdentities,
  listWorktrees,
  removeWorktree,
  renameBranch,
} from "../git";
import { readGlobalConfig } from "../globalConfig";
import { findProjectOrThrow } from "../projects";
import { applyCarryOver } from "../carryOver";
import { killScriptsForWorktree } from "../scripts";
import { readShigomoriConfig } from "../shigomori";
import { runCreateLifecycle, runDeleteCleanup } from "../worktreeLifecycle";

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
        const full = await describeWorktree(target);
        if (full.changedCount > 0) {
          throw new Error(
            `Worktree has ${full.changedCount} uncommitted change(s). Pass force=true to remove anyway.`,
          );
        }
      }

      const global = await readGlobalConfig();

      // Cleanup runs even on force-delete (force only bypasses the
      // uncommitted-changes guard, not teardown / port-pool release).
      // Electron's IPC strips structured properties off thrown errors,
      // so we surface cleanup failures as a returned discriminated
      // result instead -- the renderer's UI uses it to drive the
      // retry/skip affordance.
      if (skipCleanup !== true) {
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
      // then remove.
      await killScriptsForWorktree(worktreeId);
      await removeWorktree(project.path, target.path, force ?? false);

      // `git branch -D` refuses if the branch is still in use elsewhere,
      // so we don't need to guard against that case ourselves. Defaults
      // to true: if you're done with the worktree, you're done with the
      // local branch. (Remote branches are never touched.)
      const shouldDeleteBranch = global.deleteBranchOnRemove ?? true;
      if (shouldDeleteBranch && isRealBranch(target.branch)) {
        try {
          await deleteLocalBranch(project.path, target.branch);
        } catch {
          // Branch may be shared with another worktree or be the primary's
          // HEAD -- leaving it behind is the safe fallback.
        }
      }
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
      return describeWorktree(refreshed);
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
      return describeWorktree(refreshed);
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
}
