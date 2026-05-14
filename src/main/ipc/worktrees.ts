import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  CheckoutBranchPayloadSchema,
  type CommitSummary,
  CommitHistoryPayloadSchema,
  CreateWorktreePayloadSchema,
  DeleteWorktreePayloadSchema,
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
  listCommits,
  listWorktrees,
  removeWorktree,
  renameBranch,
} from "../git";
import { readGlobalConfig } from "../globalConfig";
import { findProjectOrThrow } from "../projects";

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
    async (_event, rawPayload: unknown): Promise<Worktree> => {
      const { projectId, worktreeName, branchName, base, checkout } =
        CreateWorktreePayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return createWorktree(
        project.id,
        project.path,
        worktreeName,
        branchName,
        base,
        checkout ?? false,
      );
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

      // Optionally clean up the local branch the worktree had checked out.
      // `git branch -D` refuses if the branch is still in use elsewhere,
      // and we skip detached HEADs (no real branch to delete).
      const config = await readGlobalConfig();
      if (
        config.deleteBranchOnRemove &&
        target.branch &&
        target.branch !== "(unknown)"
      ) {
        try {
          await deleteLocalBranch(project.path, target.branch);
        } catch {
          // Likely the branch is shared with another worktree, or is the
          // primary's HEAD. Either way, leaving the branch behind is the
          // safe fallback.
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
    CHANNELS.WorktreesCommitHistory,
    async (_event, rawPayload: unknown): Promise<CommitSummary[]> => {
      const { projectId, worktreeId, limit } =
        CommitHistoryPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      const target = await findWorktreeIdentity(
        project.id,
        project.path,
        worktreeId,
      );
      if (!target) throw new Error(`Unknown worktree: ${worktreeId}`);
      return listCommits(target.path, limit);
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
