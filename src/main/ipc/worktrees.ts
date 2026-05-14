import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  CheckoutBranchPayloadSchema,
  type CreateWorktreeResult,
  CreateWorktreePayloadSchema,
  DeleteWorktreePayloadSchema,
  isRealBranch,
  ListWorktreesPayloadSchema,
  RenameBranchPayloadSchema,
  type Worktree,
} from "@shared/schemas";
import {
  checkoutBranch,
  createWorktree,
  deleteLocalBranch,
  describeWorktree,
  findWorktreeIdentity,
  listWorktrees,
  removeWorktree,
  renameBranch,
} from "../git";
import { readGlobalConfig } from "../globalConfig";
import { findProjectOrThrow } from "../projects";
import { applyCarryOver } from "../carryOver";
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
      const target = await findWorktreeIdentity(
        project.id,
        project.path,
        worktreeId,
      );
      if (!target) throw new Error(`Unknown worktree: ${worktreeId}`);
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
      const target = await findWorktreeIdentity(
        project.id,
        project.path,
        worktreeId,
      );
      if (!target) throw new Error(`Unknown worktree: ${worktreeId}`);
      await renameBranch(target.path, newBranch);
      const refreshed = await findWorktreeIdentity(
        project.id,
        project.path,
        worktreeId,
      );
      if (!refreshed) {
        throw new Error("Worktree disappeared after rename");
      }
      return describeWorktree(refreshed);
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreesCheckoutBranch,
    async (_event, rawPayload: unknown): Promise<Worktree> => {
      const { projectId, worktreeId, branch } =
        CheckoutBranchPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      const target = await findWorktreeIdentity(
        project.id,
        project.path,
        worktreeId,
      );
      if (!target) throw new Error(`Unknown worktree: ${worktreeId}`);
      await checkoutBranch(target.path, branch);
      const refreshed = await findWorktreeIdentity(
        project.id,
        project.path,
        worktreeId,
      );
      if (!refreshed) {
        throw new Error("Worktree disappeared after checkout");
      }
      return describeWorktree(refreshed);
    },
  );
}
