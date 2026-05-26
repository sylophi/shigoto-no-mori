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
// ReadShigomoriPayloadSchema is reused here because LaunchersForProject
// has the same `{ projectId }` shape as ShigomoriRead; the read handler
// itself lives in main/ipc/shigomori.ts.
import { findWorktreeIdentityOrThrow } from "../git";
import { readGlobalConfig } from "../config/global";
import {
  type DetectedApp,
  detectApps,
  findDetected,
  launchCustom,
  launchDetected,
} from "../launchers";
import { findProjectOrThrow } from "../projects";
import { readShigomoriConfig } from "../config/project";
import { readKey, writeKey } from "../config/store";
import { countWithin, pruneAndPush } from "../util/useLog";

// Rolling-window usage so the launcher row adapts when the user switches
// tools. Each entry in the log is a launch timestamp; the score is the
// count of timestamps within the window.
const USE_LOG_KEY = "launcherUseLog";

type UseLogMap = Record<string, number[]>;

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

// Authoritative ordering used by both the LauncherRow buttons and the File
// menu ⌘1..⌘9 entries. Sort by rolling-window use count (descending),
// alphabetical by label as the tiebreaker so first-time users see a
// predictable A→Z list instead of the curated category order. The renderer
// query has a staleTime and useLaunch doesn't invalidate it, so the visible
// order stays put while the user interacts — only re-sorts when they
// navigate away and back (or the cache goes stale).
export async function getLaunchersForProject(
  projectId: string,
): Promise<LauncherEntry[]> {
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

  const log = readKey<UseLogMap>(USE_LOG_KEY, {});
  const now = Date.now();
  return entries.toSorted((a, b) => {
    const diff =
      countWithin(log[b.id] ?? [], now) - countWithin(log[a.id] ?? [], now);
    return diff !== 0 ? diff : a.label.localeCompare(b.label);
  });
}

export function registerLauncherHandlers(): void {
  ipcMain.handle(
    CHANNELS.LaunchersDetect,
    async (): Promise<DetectedLauncher[]> =>
      detectedEntries(await detectApps()).toSorted((a, b) =>
        a.label.localeCompare(b.label),
      ),
  );

  ipcMain.handle(
    CHANNELS.LaunchersForProject,
    async (
      _event,
      rawPayload: unknown,
    ): Promise<{ entries: LauncherEntry[] }> => {
      const { projectId } = ReadShigomoriPayloadSchema.parse(rawPayload);
      return { entries: await getLaunchersForProject(projectId) };
    },
  );

  ipcMain.handle(
    CHANNELS.LaunchersLaunch,
    async (_event, rawPayload: unknown): Promise<void> => {
      const { projectId, worktreeId, launcherId } =
        LaunchPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);

      const worktree = await findWorktreeIdentityOrThrow(
        project.id,
        project.path,
        worktreeId,
      );

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
  log[launcherId] = pruneAndPush(log[launcherId] ?? [], Date.now());
  writeKey<UseLogMap>(USE_LOG_KEY, log);
}
