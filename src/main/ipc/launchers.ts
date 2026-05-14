import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  type CustomLauncher,
  type DetectedLauncher,
  type GlobalConfig,
  LaunchPayloadSchema,
  type LauncherCommand,
  type LauncherEntry,
  ReadShigotoPayloadSchema,
  type ShigotoConfig,
} from "@shared/schemas";
import { findWorktreeIdentity } from "../git";
import { readGlobalConfig } from "../globalConfig";
import {
  type DetectedApp,
  detectApps,
  findDetected,
  launchCustom,
  launchDetected,
} from "../launchers";
import { findProjectOrThrow } from "../projects";
import { readShigotoConfig } from "../shigoto";

function customEntriesFrom(
  launchers: LauncherCommand[] | undefined,
): CustomLauncher[] {
  if (!launchers) return [];
  return launchers.map(
    (launcher): CustomLauncher => ({
      kind: "custom",
      id: `custom:${launcher.id}`,
      label: launcher.label,
    }),
  );
}

function findCustomCommand(
  customId: string,
  global: GlobalConfig,
  project: ShigotoConfig | null,
): LauncherCommand | undefined {
  // Project-scoped wins on the (very unlikely) id collision.
  return (
    project?.launchers?.find((l) => l.id === customId) ??
    global.launchers?.find((l) => l.id === customId)
  );
}

function detectedEntries(apps: DetectedApp[]): DetectedLauncher[] {
  return apps
    .filter((a) => a.available)
    .map(
      (a): DetectedLauncher => ({
        kind: "detected",
        id: `app:${a.id}`,
        label: a.label,
        available: true,
      }),
    );
}

export function registerLauncherHandlers(): void {
  ipcMain.handle(
    CHANNELS.ShigotoRead,
    async (_event, rawPayload: unknown): Promise<ShigotoConfig | null> => {
      const { projectId } = ReadShigotoPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return readShigotoConfig(project.id);
    },
  );

  ipcMain.handle(
    CHANNELS.LaunchersDetect,
    async (): Promise<DetectedLauncher[]> =>
      detectedEntries(await detectApps()),
  );

  ipcMain.handle(
    CHANNELS.LaunchersForProject,
    async (
      _event,
      rawPayload: unknown,
    ): Promise<{ entries: LauncherEntry[] }> => {
      const { projectId } = ReadShigotoPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);

      const [detected, projectConfig, globalConfig] = await Promise.all([
        detectApps(),
        readShigotoConfig(project.id),
        readGlobalConfig(),
      ]);

      const entries: LauncherEntry[] = [
        ...detectedEntries(detected),
        ...customEntriesFrom(globalConfig.launchers),
        ...customEntriesFrom(projectConfig?.launchers),
      ];

      return { entries };
    },
  );

  ipcMain.handle(
    CHANNELS.LaunchersLaunch,
    async (_event, rawPayload: unknown): Promise<void> => {
      const { projectId, worktreeId, launcherId } =
        LaunchPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);

      const worktree = await findWorktreeIdentity(
        project.id,
        project.path,
        worktreeId,
      );
      if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);

      if (launcherId.startsWith("app:")) {
        const appId = launcherId.slice("app:".length);
        const apps = await detectApps();
        const app = findDetected(appId, apps);
        if (!app) throw new Error(`Launcher not detected: ${appId}`);
        await launchDetected(app, worktree.path);
        return;
      }

      if (launcherId.startsWith("custom:")) {
        const customId = launcherId.slice("custom:".length);
        const [projectConfig, globalConfig] = await Promise.all([
          readShigotoConfig(project.id),
          readGlobalConfig(),
        ]);
        const custom = findCustomCommand(customId, globalConfig, projectConfig);
        if (!custom) {
          throw new Error(`Custom launcher not found: ${customId}`);
        }
        launchCustom(custom.command, worktree.path, undefined);
        return;
      }

      throw new Error(`Unknown launcher id format: ${launcherId}`);
    },
  );
}
