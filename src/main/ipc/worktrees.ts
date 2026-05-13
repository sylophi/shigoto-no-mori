import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  CreateWorktreePayloadSchema,
  DeleteWorktreePayloadSchema,
  ListWorktreesPayloadSchema,
  type Worktree,
} from "@shared/schemas";
import {
  createWorktree,
  describeWorktree,
  findWorktreeIdentity,
  listWorktrees,
  removeWorktree,
} from "../git";
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
      const { projectId, branchName, base } =
        CreateWorktreePayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return createWorktree(project.id, project.path, branchName, base);
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
        if (full.dirtyCount > 0) {
          throw new Error(
            `Worktree has ${full.dirtyCount} uncommitted change(s). Pass force=true to remove anyway.`,
          );
        }
      }
      await removeWorktree(project.path, target.path, force);
    },
  );
}
