import {
  type ClientConfig,
  DEVICE_SETTINGS_DEFAULTS as DEFAULTS,
  type GlobalConfig,
  type LauncherCommand,
  type TerminalId,
  type Theme,
} from "@shigomori/contracts/schemas/index";
import {
  type DarkTheme,
  type LightTheme,
  resolveDoubutsuPicks,
} from "./themes.ts";
import { villageNewsEnabled } from "./villageLife.ts";

// The settings form's staged state. One flat shape across both stores:
// the first thirteen fields are client config (appearance), the rest
// are device config.
export interface SettingsFormState {
  theme: Theme;
  doubutsu: boolean;
  lightTheme: LightTheme;
  darkTheme: DarkTheme;
  pauseAnimationsOnBattery: boolean;
  // Whether villager extras show is villageLifeShows' call (the
  // villager data downloaded too), never this field alone.
  villageLife: boolean;
  villageNews: boolean;
  markTerrierProjects: boolean;
  showDeviceBadges: boolean;
  allowAgentWorking: boolean;
  markAgentsWaiting: boolean;
  notifyAgentWaiting: boolean;
  notifyAgentDone: boolean;
  inlineWorktrees: boolean;
  launchers: readonly LauncherCommand[];
  hiddenLaunchers: string[];
  launchScripts: boolean;
  terminal: TerminalId;
  deleteBranchOnRemove: boolean;
  autoPopulateInstall: boolean;
  autoPullNew: boolean;
  autoPullPrimaryOnly: boolean;
  // Null while the idle shelf is off.
  autoShelveDays: number | null;
  doubutsuNames: boolean;
  codexWorktreeNames: boolean;
  managedOnProjectDrive: boolean;
  portPool: boolean;
  terrier: boolean;
  githubCli: boolean;
}

// Decode, the encoders' other half (useSettingsSave.ts). Device defaults come from the shared table
// the host's patch write stores by omission, never respelled here.
export function fromConfig(
  config: GlobalConfig,
  clientConfig: ClientConfig,
): SettingsFormState {
  const picks = resolveDoubutsuPicks(clientConfig);
  return {
    theme: clientConfig.theme ?? "system",
    doubutsu: picks.doubutsu,
    lightTheme: picks.light,
    darkTheme: picks.dark,
    pauseAnimationsOnBattery: clientConfig.pauseAnimationsOnBattery ?? true,
    villageLife: clientConfig.villageLife ?? false,
    villageNews: villageNewsEnabled(clientConfig),
    markTerrierProjects: clientConfig.markTerrierProjects ?? false,
    showDeviceBadges: clientConfig.showDeviceBadges ?? true,
    allowAgentWorking: clientConfig.allowAgentWorking ?? false,
    markAgentsWaiting: clientConfig.markAgentsWaiting ?? true,
    notifyAgentWaiting: clientConfig.notifyAgentWaiting ?? true,
    notifyAgentDone: clientConfig.notifyAgentDone ?? false,
    inlineWorktrees: clientConfig.inlineWorktrees ?? false,
    launchers: config.launchers ?? [],
    // Sorted here and on every toggle so the id list has one canonical
    // order. useDirtyForm compares FormState by JSON.stringify, and
    // hiding is set-semantic -- without this, re-hiding a tool in a
    // different order would read as an unsaved change.
    hiddenLaunchers: (config.hiddenLaunchers ?? []).toSorted(),
    launchScripts: config.launchScripts ?? DEFAULTS.launchScripts,
    terminal: config.terminal ?? DEFAULTS.terminal,
    deleteBranchOnRemove:
      config.deleteBranchOnRemove ?? DEFAULTS.deleteBranchOnRemove,
    autoPopulateInstall:
      config.autoPopulateInstall ?? DEFAULTS.autoPopulateInstall,
    autoPullNew: config.autoPullNew ?? DEFAULTS.autoPullNew,
    autoPullPrimaryOnly:
      config.autoPullPrimaryOnly ?? DEFAULTS.autoPullPrimaryOnly,
    autoShelveDays: config.autoShelveDays ?? DEFAULTS.autoShelveDays,
    doubutsuNames: config.doubutsuNames ?? DEFAULTS.doubutsuNames,
    codexWorktreeNames:
      config.codexWorktreeNames ?? DEFAULTS.codexWorktreeNames,
    managedOnProjectDrive:
      config.managedOnProjectDrive ?? DEFAULTS.managedOnProjectDrive,
    portPool: config.portPool ?? DEFAULTS.portPool,
    terrier: config.terrier ?? DEFAULTS.terrier,
    githubCli: config.githubCli ?? DEFAULTS.githubCli,
  };
}
