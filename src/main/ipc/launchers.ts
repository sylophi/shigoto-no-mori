import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  type CustomLauncher,
  type DetectedLauncher,
  type GlobalConfig,
  LaunchPayloadSchema,
  type LauncherCommand,
  type LauncherEntry,
  ReadShigomoriPayloadSchema,
  type ShigomoriConfig,
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
import { readShigomoriConfig } from "../shigomori";
import { readKey, writeKey } from "../store";

// Rolling-window usage so the launcher row adapts when the user switches
// tools. Each entry in the log is a launch timestamp; the score is the
// count of timestamps within the window.
const USE_LOG_KEY = "launcherUseLog";
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

type UseLogMap = Record<string, number[]>;

function recentScore(log: UseLogMap, id: string, now: number): number {
  const cutoff = now - WINDOW_MS;
  let n = 0;
  for (const t of log[id] ?? []) if (t >= cutoff) n++;
  return n;
}

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
  project: ShigomoriConfig | null,
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
    CHANNELS.ShigomoriRead,
    async (_event, rawPayload: unknown): Promise<ShigomoriConfig | null> => {
      const { projectId } = ReadShigomoriPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return readShigomoriConfig(project.id);
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
      const { projectId } = ReadShigomoriPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);

      const [detected, projectConfig, globalConfig] = await Promise.all([
        detectApps(),
        readShigomoriConfig(project.id),
        readGlobalConfig(),
      ]);

      const entries: LauncherEntry[] = [
        ...detectedEntries(detected).filter((e) => e.available),
        ...customEntriesFrom(globalConfig.launchers),
        ...customEntriesFrom(projectConfig?.launchers),
      ];

      // Sort by rolling-window use count (descending). toSorted is stable, so
      // ties preserve the original detected → global → project order. The
      // renderer query has a staleTime and useLaunch doesn't invalidate it,
      // so the visible order stays put while the user interacts — only
      // re-sorts when they navigate away and back (or the cache goes stale).
      const log = readKey<UseLogMap>(USE_LOG_KEY, {});
      const now = Date.now();
      return {
        entries: entries.toSorted(
          (a, b) => recentScore(log, b.id, now) - recentScore(log, a.id, now),
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
          readShigomoriConfig(project.id),
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
  const log = readKey<UseLogMap>(USE_LOG_KEY, {});
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const fresh = (log[launcherId] ?? []).filter((t) => t >= cutoff);
  fresh.push(now);
  log[launcherId] = fresh;
  writeKey<UseLogMap>(USE_LOG_KEY, log);
}
