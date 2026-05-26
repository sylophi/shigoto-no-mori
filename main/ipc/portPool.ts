import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import { PortPoolIsActivePayloadSchema } from "@shared/schemas";
import { findWorktreeIdentityOrThrow } from "../git";
import { readGlobalConfig } from "../config/global";
import { isPortPoolConfigured, isPortPoolInstalled } from "../portPool";
import { findProjectOrThrow } from "../projects";

export function registerPortPoolHandlers(): void {
  ipcMain.handle(
    CHANNELS.PortPoolIsActive,
    async (_event, rawPayload: unknown): Promise<boolean> => {
      const { projectId, worktreeId } =
        PortPoolIsActivePayloadSchema.parse(rawPayload);
      const global = await readGlobalConfig();
      if (!global.portPool) return false;
      const project = findProjectOrThrow(projectId);
      const [installed, worktree] = await Promise.all([
        isPortPoolInstalled(),
        findWorktreeIdentityOrThrow(project.id, project.path, worktreeId),
      ]);
      if (!installed) return false;
      return isPortPoolConfigured(worktree.path);
    },
  );

  ipcMain.handle(CHANNELS.PortPoolIsInstalled, async (): Promise<boolean> => {
    return isPortPoolInstalled();
  });
}
