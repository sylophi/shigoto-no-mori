import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  CancelScriptPayloadSchema,
  type Project,
  RunScriptPayloadSchema,
  type Worktree,
} from "@shared/schemas";
import { listWorktrees } from "../git";
import { cancelScript, startScript } from "../scripts";
import { readShigotoConfig } from "../shigoto";
import { readKey } from "../store";

const PROJECTS_KEY = "projects";

function findProject(projectId: string): Project | undefined {
  return readKey<Project[]>(PROJECTS_KEY, []).find((p) => p.id === projectId);
}

export function registerScriptHandlers(): void {
  ipcMain.handle(
    CHANNELS.ScriptsRun,
    async (event, rawPayload: unknown): Promise<{ runId: string }> => {
      const { projectId, worktreeId, script } =
        RunScriptPayloadSchema.parse(rawPayload);

      const project = findProject(projectId);
      if (!project) throw new Error(`Unknown project: ${projectId}`);

      const config = await readShigotoConfig(project.path);
      const command = config?.scripts?.[script];
      if (!command || command.trim() === "") {
        throw new Error(
          `No "${script}" script defined in shigoto.json for ${project.name}`,
        );
      }

      const worktrees = await listWorktrees(project.id, project.path);
      const worktree = worktrees.find((w: Worktree) => w.id === worktreeId);
      if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);

      const runId = startScript({
        command,
        cwd: worktree.path,
        scriptName: script,
        worktreeId: worktree.id,
        port: worktree.port,
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
