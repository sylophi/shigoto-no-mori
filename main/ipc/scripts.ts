import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  CancelScriptPayloadSchema,
  RunScriptPayloadSchema,
} from "@shared/schemas";
import { listWorktreeIdentities, resolveDefaultBranch } from "../git";
import { findProjectOrThrow } from "../projects";
import { resolveScriptCommand } from "../scripts/command";
import { cancelScript, startScript } from "../scripts";
import { readShigomoriConfig } from "../config/project";

export function registerScriptHandlers(): void {
  ipcMain.handle(
    CHANNELS.ScriptsRun,
    async (event, rawPayload: unknown): Promise<{ runId: string }> => {
      const { projectId, worktreeId, script } =
        RunScriptPayloadSchema.parse(rawPayload);

      const project = findProjectOrThrow(projectId);

      const config = await readShigomoriConfig(project.id);

      const [identities, defaultBranch] = await Promise.all([
        listWorktreeIdentities(project.id, project.path),
        resolveDefaultBranch(project.path, config?.defaultBranch).catch(
          () => "",
        ),
      ]);
      const worktree = identities.find((i) => i.id === worktreeId);
      if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);

      const command = resolveScriptCommand(script, config, worktree.path);
      if (!command) {
        throw new Error(`No "${script}" script configured for ${project.name}`);
      }

      const runId = startScript({
        command,
        scriptName: script,
        worktree,
        project,
        projectBranch: identities.find((i) => i.isPrimary)?.branch ?? "",
        defaultBranch,
        webContents: event.sender,
      });
      return { runId };
    },
  );

  ipcMain.handle(
    CHANNELS.ScriptsCancel,
    async (_event, rawPayload: unknown): Promise<{ cancelled: boolean }> => {
      const { runId } = CancelScriptPayloadSchema.parse(rawPayload);
      const cancelled = await cancelScript(runId);
      return { cancelled };
    },
  );
}
