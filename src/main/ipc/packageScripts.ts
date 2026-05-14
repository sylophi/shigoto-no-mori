import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  ListPackageScriptsPayloadSchema,
  type PackageScriptsResult,
  RunPackageScriptPayloadSchema,
} from "@shared/schemas";
import {
  findWorktreeIdentity,
  listWorktreeIdentities,
  resolveDefaultBranch,
} from "../git";
import { buildScriptCommand, readPackageScripts } from "../packageScripts";
import { findProjectOrThrow } from "../projects";
import { startScript } from "../scripts";
import { readShigomoriConfig } from "../shigomori";

export function registerPackageScriptHandlers(): void {
  ipcMain.handle(
    CHANNELS.PackageScriptsList,
    async (
      _event,
      rawPayload: unknown,
    ): Promise<PackageScriptsResult | null> => {
      const { projectId, worktreeId } =
        ListPackageScriptsPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      const worktree = await findWorktreeIdentity(
        project.id,
        project.path,
        worktreeId,
      );
      if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);
      return readPackageScripts(worktree.path);
    },
  );

  ipcMain.handle(
    CHANNELS.PackageScriptsRun,
    async (event, rawPayload: unknown): Promise<{ runId: string }> => {
      const { projectId, worktreeId, scriptName } =
        RunPackageScriptPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);

      const config = await readShigomoriConfig(project.id);
      const identities = await listWorktreeIdentities(project.id, project.path);
      const worktree = identities.find((i) => i.id === worktreeId);
      if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);

      const [defaultBranch, pkg] = await Promise.all([
        resolveDefaultBranch(project.path, config?.defaultBranch).catch(
          () => "",
        ),
        readPackageScripts(worktree.path),
      ]);
      if (!pkg || !(scriptName in pkg.scripts)) {
        throw new Error(
          `Script "${scriptName}" is not defined in package.json`,
        );
      }

      const command = buildScriptCommand(pkg.packageManager, scriptName);
      const runId = startScript({
        command,
        scriptName,
        worktree,
        project,
        projectBranch: identities.find((i) => i.isPrimary)?.branch ?? "",
        defaultBranch,
        webContents: event.sender,
      });
      return { runId };
    },
  );
}
