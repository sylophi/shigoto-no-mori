import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  CheckoutBranchPayloadSchema,
  CommitDiffPayloadSchema,
  type CreateWorktreeResult,
  CreateWorktreePayloadSchema,
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
  listWorktrees,
  removeWorktree,
  renameBranch,
} from "../git";
import { readGlobalConfig } from "../globalConfig";
import { findProjectOrThrow } from "../projects";
import { applyCarryOver } from "../carryOver";
import { killScriptsForWorktree } from "../scripts";
import { readShigomoriConfig } from "../shigomori";

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
    async (_event, rawPayload: unknown): Promise<CreateWorktreeResult> => {
      const { projectId, worktreeName, branchName, base, checkout } =
        CreateWorktreePayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      const worktree = await createWorktree(project.id, project.path, {
        requestedWorktreeName: worktreeName,
        branchName,
        base,
        checkout: checkout ?? false,
      });
      const config = await readShigomoriConfig(project.id).catch(() => null);
      const carryOver = await applyCarryOver(
        project.path,
        worktree.path,
        config?.carryOver ?? [],
      );
      return { worktree, carryOver };
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreesDelete,
    async (_event, rawPayload: unknown): Promise<void> => {
      const { projectId, worktreeId, force } =
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
      // Any package script still running here would be holding the
      // worktree as its cwd; reap before git rips the directory.
      await killScriptsForWorktree(worktreeId);
      await removeWorktree(project.path, target.path, force);

      // `git branch -D` refuses if the branch is still in use elsewhere,
      // so we don't need to guard against that case ourselves. Defaults
      // to true: if you're done with the worktree, you're done with the
      // local branch. (Remote branches are never touched.)
      const config = await readGlobalConfig();
      const shouldDeleteBranch = config.deleteBranchOnRemove ?? true;
      if (shouldDeleteBranch && isRealBranch(target.branch)) {
        try {
          await deleteLocalBranch(project.path, target.branch);
        } catch {
          // Branch may be shared with another worktree or be the primary's
          // HEAD — leaving it behind is the safe fallback.
        }
      }
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
