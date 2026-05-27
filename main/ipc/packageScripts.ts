import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  GetPackageScriptSortPayloadSchema,
  ListPackageScriptsPayloadSchema,
  type PackageScriptSortMode,
  type PackageScriptsResult,
  RunPackageScriptPayloadSchema,
  SetPackageScriptSortPayloadSchema,
} from "@shared/schemas";
import {
  findWorktreeIdentityOrThrow,
  listWorktreeIdentities,
  resolveDefaultBranch,
} from "../lib/git";
import {
  buildScriptCommand,
  readPackageScripts,
} from "../lib/scripts/packageScripts";
import {
  bumpScriptUseCount,
  readScriptSort,
  usageFor,
  writeScriptSort,
} from "../lib/scripts/packageScriptStats";
import { findProjectOrThrow } from "../lib/projects";
import { startScript } from "../lib/scripts";
import { readShigomoriConfig } from "../lib/config/project";

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
      const worktree = await findWorktreeIdentityOrThrow(
        project.id,
        project.path,
        worktreeId,
      );
      const file = await readPackageScripts(worktree.path);
      if (!file) return null;
      return {
        ...file,
        usage: usageFor(project.id, Object.keys(file.scripts)),
      };
    },
  );

  ipcMain.handle(
    CHANNELS.PackageScriptsGetSort,
    async (_event, rawPayload: unknown): Promise<PackageScriptSortMode> => {
      const { projectId } = GetPackageScriptSortPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return readScriptSort(project.id);
    },
  );

  ipcMain.handle(
    CHANNELS.PackageScriptsSetSort,
    async (_event, rawPayload: unknown): Promise<void> => {
      const { projectId, mode } =
        SetPackageScriptSortPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      writeScriptSort(project.id, mode);
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
      bumpScriptUseCount(project.id, scriptName);
      return { runId };
    },
  );
}
