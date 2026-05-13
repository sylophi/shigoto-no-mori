import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  type CustomLauncher,
  type DetectedLauncher,
  LaunchPayloadSchema,
  type LauncherEntry,
  ReadShigotoPayloadSchema,
  SetPreferredLauncherPayloadSchema,
  type ShigotoConfig,
} from "@shared/schemas";
import { findWorktreeIdentity } from "../git";
import {
  type DetectedApp,
  detectApps,
  findDetected,
  launchCustom,
  launchDetected,
} from "../launchers";
import { findProjectOrThrow } from "../projects";
import { readShigotoConfig } from "../shigoto";
import { readKey, writeKey } from "../store";

const PREFERRED_KEY = "launcherPreferences";

type PreferredMap = Record<string, string>;

function customEntries(config: ShigotoConfig | null): CustomLauncher[] {
  if (!config?.launchers) return [];
  return config.launchers.map(
    (launcher): CustomLauncher => ({
      kind: "custom",
      id: `custom:${launcher.id}`,
      label: launcher.label,
    }),
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
        icon: a.icon,
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
      return readShigotoConfig(project.path);
    },
  );

  ipcMain.handle(
    CHANNELS.LaunchersDetect,
    async (): Promise<DetectedApp[]> => detectApps(),
  );

  ipcMain.handle(
    CHANNELS.LaunchersForProject,
    async (
      _event,
      rawPayload: unknown,
    ): Promise<{
      entries: LauncherEntry[];
      preferred: string | null;
    }> => {
      const { projectId } = ReadShigotoPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);

      const [detected, config] = await Promise.all([
        detectApps(),
        readShigotoConfig(project.path),
      ]);

      const entries: LauncherEntry[] = [
        ...detectedEntries(detected),
        ...customEntries(config),
      ];

      const preferences = readKey<PreferredMap>(PREFERRED_KEY, {});
      const preferred =
        preferences[projectId] &&
        entries.some((e) => e.id === preferences[projectId])
          ? preferences[projectId]
          : (entries[0]?.id ?? null);

      return { entries, preferred };
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
        const config = await readShigotoConfig(project.path);
        const customId = launcherId.slice("custom:".length);
        const custom = config?.launchers?.find((l) => l.id === customId);
        if (!custom)
          throw new Error(
            `Custom launcher not in shigomori.config.json: ${customId}`,
          );
        launchCustom(custom.command, worktree.path, undefined);
        return;
      }

      throw new Error(`Unknown launcher id format: ${launcherId}`);
    },
  );

  ipcMain.handle(
    CHANNELS.LaunchersSetPreferred,
    async (_event, rawPayload: unknown): Promise<void> => {
      const { projectId, launcherId } =
        SetPreferredLauncherPayloadSchema.parse(rawPayload);
      const preferences = readKey<PreferredMap>(PREFERRED_KEY, {});
      preferences[projectId] = launcherId;
      writeKey<PreferredMap>(PREFERRED_KEY, preferences);
    },
  );
}
