import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  CancelScriptPayloadSchema,
  RunScriptPayloadSchema,
} from "@shared/schemas";
import { listWorktreeIdentities, resolveDefaultBranch } from "../git";
import { findProjectOrThrow } from "../projects";
import { cancelScript, startScript } from "../scripts";
import { readShigomoriConfig } from "../shigomori";

export function registerScriptHandlers(): void {
  ipcMain.handle(
    CHANNELS.ScriptsRun,
    async (event, rawPayload: unknown): Promise<{ runId: string }> => {
      const { projectId, worktreeId, script } =
        RunScriptPayloadSchema.parse(rawPayload);

      const project = findProjectOrThrow(projectId);

      const config = await readShigomoriConfig(project.id);
      const command = config?.scripts?.[script];
      if (!command || command.trim() === "") {
        throw new Error(`No "${script}" script configured for ${project.name}`);
      }

      // Single listWorktreeIdentities call gives us both the worktree the
      // script runs in *and* the primary's branch for $SHIGOMORI_PROJECT_BRANCH.
      const [identities, defaultBranch] = await Promise.all([
        listWorktreeIdentities(project.id, project.path),
        resolveDefaultBranch(project.path, config?.defaultBranch).catch(
          () => "",
        ),
      ]);
      const worktree = identities.find((i) => i.id === worktreeId);
      if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);
      const primary = identities.find((i) => i.isPrimary);

      const runId = startScript({
        command,
        cwd: worktree.path,
        scriptName: script,
        worktreeId: worktree.id,
        worktreeName: worktree.name,
        worktreeBranch: worktree.branch,
        projectPath: project.path,
        projectName: project.name,
        projectBranch: primary?.branch ?? "",
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
      return { cancelled: cancelScript(runId) };
    },
  );
}
