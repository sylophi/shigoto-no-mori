import { shell } from "electron";
import { launchersContract } from "@shared/ipc/modules/launchers";
import type { Handlers } from "@shared/ipc/types";
import {
  WEB_GITHUB_ID,
  type CustomLauncher,
  type DetectedLauncher,
  type GlobalConfig,
  type LauncherCommand,
  type LauncherEntry,
  type ShigomoriConfig,
  type WebLauncher,
} from "@shared/schemas";
import { readGlobalConfig } from "../../lib/config/global";
import { readShigomoriConfig } from "../../lib/config/project";
import { stateStore } from "../../lib/config/store";
import { findWorktreeIdentityOrThrow } from "../../lib/git/worktrees";
import {
  deepLinkFor,
  type DetectedApp,
  detectApps,
  findDetected,
  launchCustom,
  launchDetected,
} from "../../lib/launchers";
import { getGithubRepoInfo, githubRepoUrl } from "../../lib/githubCli/remote";
import { findProjectOrThrow } from "../../lib/projects";
import { countWithin, pruneAndPush } from "../../lib/util/useLog";

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

async function webEntriesFor(projectPath: string): Promise<WebLauncher[]> {
  const info = await getGithubRepoInfo(projectPath);
  if (!info) return [];
  return [{ kind: "web", id: WEB_GITHUB_ID, label: "GitHub" }];
}

// Authoritative ordering used by both the LauncherRow buttons and the File
// menu ⌘1..⌘9 entries. Sort by rolling-window use count (descending),
// alphabetical by label as the tiebreaker so first-time users see a
// predictable A→Z list instead of the curated category order. The renderer
// query has a staleTime and useLaunch doesn't invalidate it, so the visible
// order stays put while the user interacts — only re-sorts when they
// navigate away and back (or the cache goes stale).
async function getLaunchersForProject(
  projectId: string,
): Promise<{ entries: LauncherEntry[]; hiddenCount: number }> {
  const project = findProjectOrThrow(projectId);
  const [detected, projectConfig, globalConfig, web] = await Promise.all([
    detectApps(),
    readShigomoriConfig(project.id),
    readGlobalConfig(),
    webEntriesFor(project.path),
  ]);

  const resolvable: LauncherEntry[] = [
    ...detectedEntries(detected).filter((e) => e.available),
    ...web,
    ...customEntriesFrom(globalConfig.launchers),
    ...customEntriesFrom(projectConfig?.launchers),
  ];

  // Hiding is presentational only: `launch` still resolves a hidden id, so
  // an in-flight deep link or a stale menu accelerator keeps working.
  const hidden = new Set(globalConfig.hiddenLaunchers ?? []);
  const entries = resolvable.filter((e) => !hidden.has(e.id));

  const log = stateStore.readHint<UseLogMap>(USE_LOG_KEY, {});
  const now = Date.now();
  return {
    entries: entries.toSorted((a, b) => {
      const diff =
        countWithin(log[b.id] ?? [], now) - countWithin(log[a.id] ?? [], now);
      return diff !== 0 ? diff : a.label.localeCompare(b.label);
    }),
    hiddenCount: resolvable.length - entries.length,
  };
}

function bumpUseCount(launcherId: string): void {
  // updateKey, not readKey + writeKey: the CLI (`sm open`) bumps the
  // same key under the state lock, and a read taken outside it would
  // silently clobber a concurrent terminal-side bump.
  stateStore.updateKey<UseLogMap>(USE_LOG_KEY, {}, (log) => {
    log[launcherId] = pruneAndPush(log[launcherId] ?? [], Date.now());
    return log;
  });
}

export const launchersHandlers: Handlers<typeof launchersContract> = {
  detect: async () =>
    detectedEntries(await detectApps()).toSorted((a, b) =>
      a.label.localeCompare(b.label),
    ),

  forProject: async ({ projectId }) => getLaunchersForProject(projectId),

  launch: async ({ projectId, worktreeId, launcherId }) => {
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
      // Protocol-based apps (Codex, Claude) open via the OS URL handler.
      // shell.openExternal lives here rather than in lib/launchers so
      // that module stays Electron-free.
      const deepLink = deepLinkFor(appId, worktree.path);
      if (deepLink) {
        await shell.openExternal(deepLink);
      } else {
        await launchDetected(app, worktree.path);
      }
      bumpUseCount(launcherId);
      return;
    }

    if (launcherId === WEB_GITHUB_ID) {
      const info = await getGithubRepoInfo(project.path);
      if (!info) throw new Error(`GitHub remote not found: ${project.name}`);
      await shell.openExternal(githubRepoUrl(info));
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
      launchCustom(custom.command, worktree.path);
      bumpUseCount(launcherId);
      return;
    }

    throw new Error(`Unknown launcher id format: ${launcherId}`);
  },
};
