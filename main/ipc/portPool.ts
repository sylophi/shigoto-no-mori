import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "@shared/channels";
import { findWorktreeIdentityOrThrow } from "../git";
import { readGlobalConfig } from "../config/global";
import { isPortPoolInstalled, PortPool, runPortPoolProgram } from "../portPool";
import { findProjectOrThrow } from "../projects";

const PayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
});

export function registerPortPoolHandlers(): void {
  ipcMain.handle(
    CHANNELS.PortPoolIsActive,
    async (_event, rawPayload: unknown): Promise<boolean> => {
      const { projectId, worktreeId } = PayloadSchema.parse(rawPayload);
      const global = await readGlobalConfig();
      if (!global.portPool) return false;
      const project = findProjectOrThrow(projectId);
      const worktree = await findWorktreeIdentityOrThrow(
        project.id,
        project.path,
        worktreeId,
      );
      return runPortPoolProgram(PortPool.isActive(worktree.path));
    },
  );

  ipcMain.handle(CHANNELS.PortPoolIsInstalled, async (): Promise<boolean> => {
    return isPortPoolInstalled();
  });
}
