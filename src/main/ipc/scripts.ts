import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  CancelScriptPayloadSchema,
  RunScriptPayloadSchema,
} from "@shared/schemas";
import { findWorktreeIdentity } from "../git";
import { findProjectOrThrow } from "../projects";
import { cancelScript, startScript } from "../scripts";
import { readShigotoConfig } from "../shigoto";

export function registerScriptHandlers(): void {
  ipcMain.handle(
    CHANNELS.ScriptsRun,
    async (event, rawPayload: unknown): Promise<{ runId: string }> => {
      const { projectId, worktreeId, script } =
        RunScriptPayloadSchema.parse(rawPayload);

      const project = findProjectOrThrow(projectId);

      const config = await readShigotoConfig(project.path);
      const command = config?.scripts?.[script];
      if (!command || command.trim() === "") {
        throw new Error(
          `No "${script}" script defined in shigoto.json for ${project.name}`,
        );
      }

      const worktree = await findWorktreeIdentity(
        project.id,
        project.path,
        worktreeId,
      );
      if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);

      const runId = startScript({
        command,
        cwd: worktree.path,
        scriptName: script,
        worktreeId: worktree.id,
        port: undefined,
        webContents: event.sender,
      });
      return { runId };
    },
  );

  ipcMain.handle(
    CHANNELS.ScriptsCancel,
    async (_event, rawPayload: unknown): Promise<{ cancelled: boolean }> => {
      const { runId } = CancelScriptPayloadSchema.parse(rawPayload);
      return { cancelled: cancelScript(runId) };
    },
  );
}
