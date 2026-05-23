import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  CreateBranchPayloadSchema,
  DeleteBranchPayloadSchema,
  RenameAnyBranchPayloadSchema,
} from "@shared/schemas";
import {
  createLocalBranch,
  deleteAnyLocalBranch,
  renameAnyLocalBranch,
} from "../git";
import { findProjectOrThrow } from "../projects";

export function registerBranchHandlers(): void {
  ipcMain.handle(
    CHANNELS.BranchesCreate,
    async (_event, rawPayload: unknown): Promise<void> => {
      const { projectId, name, base } =
        CreateBranchPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      await createLocalBranch(project.path, name, base);
    },
  );

  ipcMain.handle(
    CHANNELS.BranchesRename,
    async (_event, rawPayload: unknown): Promise<void> => {
      const { projectId, oldName, newName } =
        RenameAnyBranchPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      await renameAnyLocalBranch(project.path, oldName, newName);
    },
  );

  ipcMain.handle(
    CHANNELS.BranchesDelete,
    async (_event, rawPayload: unknown): Promise<void> => {
      const { projectId, name } = DeleteBranchPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      await deleteAnyLocalBranch(project.path, name);
    },
  );
}
