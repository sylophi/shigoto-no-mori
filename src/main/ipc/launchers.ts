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
import { readKey, writeKey } from "../store";

const USE_COUNT_KEY = "launcherUseCount";
type UseCountMap = Record<string, number>;

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
  return apps.map(
    (a): DetectedLauncher => ({
      kind: "detected",
      id: `app:${a.id}`,
      label: a.label,
      available: a.available,
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
        ...detectedEntries(detected).filter((e) => e.available),
        ...customEntriesFrom(globalConfig.launchers),
        ...customEntriesFrom(projectConfig?.launchers),
      ];

      // Sort by all-time use count (descending). toSorted is stable, so ties
      // preserve the original detected → global → project order. The renderer
      // query has a staleTime and useLaunch doesn't invalidate it, so the
      // visible order doesn't shift while the user is interacting — only
      // re-sorts when they navigate away and back (or the cache goes stale).
      const counts = readKey<UseCountMap>(USE_COUNT_KEY, {});
      return {
        entries: entries.toSorted(
          (a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0),
        ),
      };
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
        bumpUseCount(launcherId);
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
        bumpUseCount(launcherId);
        return;
      }

      throw new Error(`Unknown launcher id format: ${launcherId}`);
    },
  );
}

function bumpUseCount(launcherId: string): void {
  const counts = readKey<UseCountMap>(USE_COUNT_KEY, {});
  counts[launcherId] = (counts[launcherId] ?? 0) + 1;
  writeKey<UseCountMap>(USE_COUNT_KEY, counts);
}
